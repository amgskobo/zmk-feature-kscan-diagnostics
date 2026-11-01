/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zmk/event_manager.h>
#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/query.h>
#include <cormoran/kscan_diagnostics/relay.h>
#include <cormoran/kscan_diagnostics/relay_events.h>

#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC)
#include <zmk/studio/custom.h>
#endif

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

/*
 * Wire both relay carriers in both directions. The direction macros are
 * self-role-gating (the wrong-direction one expands empty per role), and the
 * HANDLE macros only fire when a relay frame with the matching identifier is
 * actually received -- a central never receives "K2q" and a peripheral never
 * receives "K2r", so listing all four here is safe on either role.
 *
 *   central  --K2q (query)-->  peripheral   (CENTRAL_TO_PERIPHERAL + HANDLE)
 *   peripheral --K2r (reply)--> central     (PERIPHERAL_TO_CENTRAL + HANDLE)
 */
ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL(ksd_relay_query, K2q, source)
ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL(ksd_relay_reply, K2r, source)
ZMK_RELAY_EVENT_HANDLE(ksd_relay_query, K2q, source)
ZMK_RELAY_EVENT_HANDLE(ksd_relay_reply, K2r, source)

/*
 * Dedicated work queue for the heavy half of the relay.
 *
 * The relay carriers are re-raised locally by ZMK_RELAY_EVENT_HANDLE from the
 * split relay-receive path, which runs on the SYSTEM work queue. Answering a
 * query (peripheral: decode + dispatch + encode) and -- worse -- raising a
 * Studio notification (central: raise_zmk_studio_custom_notification builds a
 * full zmk_studio_Notification AND zmk_studio_Response and runs a double
 * pb_encode, all synchronously) needs far more stack than the ~2 KB system
 * work queue has spare after the BLE receive path. Doing it there overflows
 * the sysworkq stack (observed on hardware). So the event listeners below only
 * copy the carrier into a msgq and kick this queue; the real work runs here
 * with an RPC-thread-sized stack.
 */
static K_THREAD_STACK_DEFINE(ksd_relay_stack, CONFIG_ZMK_KSCAN_DIAGNOSTICS_RELAY_STACK_SIZE);
static struct k_work_q ksd_relay_workq;

static int ksd_relay_workq_init(void) {
    struct k_work_queue_config cfg = {.name = "ksd_relay"};
    k_work_queue_start(&ksd_relay_workq, ksd_relay_stack, K_THREAD_STACK_SIZEOF(ksd_relay_stack),
                       K_LOWEST_APPLICATION_THREAD_PRIO, &cfg);
    return 0;
}

SYS_INIT(ksd_relay_workq_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);

#if !IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)

/*
 * Peripheral side: a relayed query re-raised locally by
 * ZMK_RELAY_EVENT_HANDLE(ksd_relay_query). Answer it -- against THIS
 * peripheral's own topology/stats tables -- on the relay work queue and raise
 * a reply (relayed back to the central).
 *
 * The work queue is single-threaded and drains the msgq serially, so the
 * static scratch buffers below need no extra locking and keep the work-queue
 * stack free for the pb_encode below.
 */
K_MSGQ_DEFINE(ksd_relay_query_msgq, sizeof(struct ksd_relay_query), 4, 4);

static cormoran_kscan_diagnostics_Request answer_req;
static cormoran_kscan_diagnostics_Response answer_resp;
static struct ksd_relay_reply answer_reply;
static struct ksd_relay_query answer_query;

static void ksd_relay_answer_work(struct k_work *work) {
    while (k_msgq_get(&ksd_relay_query_msgq, &answer_query, K_NO_WAIT) == 0) {
        answer_req =
            (cormoran_kscan_diagnostics_Request)cormoran_kscan_diagnostics_Request_init_zero;
        pb_istream_t is = pb_istream_from_buffer(answer_query.data, answer_query.len);
        if (!pb_decode(&is, cormoran_kscan_diagnostics_Request_fields, &answer_req)) {
            LOG_WRN("Failed to decode relayed kscan diagnostics query: %s", PB_GET_ERROR(&is));
            continue;
        }

        answer_resp =
            (cormoran_kscan_diagnostics_Response)cormoran_kscan_diagnostics_Response_init_zero;
        ksd_query_dispatch(&answer_req, &answer_resp);

        answer_reply = (struct ksd_relay_reply){
            .source = ZMK_RELAY_EVENT_SOURCE_SELF,
            .req_id = answer_query.req_id,
        };
        pb_ostream_t os = pb_ostream_from_buffer(answer_reply.data, sizeof(answer_reply.data));
        if (!pb_encode(&os, cormoran_kscan_diagnostics_Response_fields, &answer_resp)) {
            LOG_ERR("Failed to encode relayed kscan diagnostics reply: %s", PB_GET_ERROR(&os));
            continue;
        }
        answer_reply.len = (uint8_t)os.bytes_written;

        raise_ksd_relay_reply(answer_reply);
    }
}

static K_WORK_DEFINE(ksd_relay_answer_work_item, ksd_relay_answer_work);

static int ksd_relay_on_query(const zmk_event_t *eh) {
    const struct ksd_relay_query *query = as_ksd_relay_query(eh);
    if (query == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (k_msgq_put(&ksd_relay_query_msgq, query, K_NO_WAIT) != 0) {
        LOG_WRN("kscan diagnostics relay query queue full, dropping query");
        return ZMK_EV_EVENT_BUBBLE;
    }
    k_work_submit_to_queue(&ksd_relay_workq, &ksd_relay_answer_work_item);
    return ZMK_EV_EVENT_HANDLED;
}

ZMK_LISTENER(ksd_relay_answer, ksd_relay_on_query);
ZMK_SUBSCRIPTION(ksd_relay_answer, ksd_relay_query);

#else // CONFIG_ZMK_SPLIT_ROLE_CENTRAL

/*
 * Central side: a peripheral's reply re-raised locally by
 * ZMK_RELAY_EVENT_HANDLE(ksd_relay_reply), with `source` stamped to the
 * peripheral index+1. Forward it to the connected Studio client as a
 * PeripheralEvent notification -- on the relay work queue, because
 * raise_zmk_studio_custom_notification encodes the whole notification
 * synchronously and overflows the system work queue stack. Only compiled when
 * the Studio RPC subsystem is present (that is where notifications go).
 */
#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC)

#define KSCAN_DIAGNOSTICS_SUBSYSTEM_IDENTIFIER "cormoran__kscan_diagnostics"

static int ksd_relay_subsystem_index(void) {
    size_t count;
    STRUCT_SECTION_COUNT(zmk_rpc_custom_subsystem, &count);
    for (size_t i = 0; i < count; i++) {
        struct zmk_rpc_custom_subsystem *subsys;
        STRUCT_SECTION_GET(zmk_rpc_custom_subsystem, i, &subsys);
        if (strcmp(subsys->identifier, KSCAN_DIAGNOSTICS_SUBSYSTEM_IDENTIFIER) == 0) {
            return (int)i;
        }
    }
    return -ENOENT;
}

static bool ksd_relay_encode_peripheral_event(pb_ostream_t *stream, const pb_field_t *field,
                                              void *const *arg) {
    const cormoran_kscan_diagnostics_PeripheralEvent *event =
        (const cormoran_kscan_diagnostics_PeripheralEvent *)*arg;
    return zmk_rpc_custom_subsystem_encode_response_payload(
        stream, field, cormoran_kscan_diagnostics_PeripheralEvent_fields, event);
}

K_MSGQ_DEFINE(ksd_relay_reply_msgq, sizeof(struct ksd_relay_reply), 4, 4);

static struct ksd_relay_reply notify_reply;
static cormoran_kscan_diagnostics_PeripheralEvent notify_event;

static void ksd_relay_notify_work(struct k_work *work) {
    while (k_msgq_get(&ksd_relay_reply_msgq, &notify_reply, K_NO_WAIT) == 0) {
        int index = ksd_relay_subsystem_index();
        if (index < 0) {
            LOG_WRN("kscan diagnostics subsystem not registered, dropping peripheral reply");
            continue;
        }

        notify_event = (cormoran_kscan_diagnostics_PeripheralEvent)
            cormoran_kscan_diagnostics_PeripheralEvent_init_zero;
        notify_event.source = notify_reply.source;
        notify_event.req_id = notify_reply.req_id;
        notify_event.payload.size = MIN(notify_reply.len, sizeof(notify_event.payload.bytes));
        memcpy(notify_event.payload.bytes, notify_reply.data, notify_event.payload.size);

        // encode_payload runs inline within raise_zmk_studio_custom_notification,
        // so pointing at the (static) notify_event is safe.
        raise_zmk_studio_custom_notification((struct zmk_studio_custom_notification){
            .subsystem_index = (uint8_t)index,
            .encode_payload =
                {
                    .funcs.encode = ksd_relay_encode_peripheral_event,
                    .arg = (void *)&notify_event,
                },
        });
    }
}

static K_WORK_DEFINE(ksd_relay_notify_work_item, ksd_relay_notify_work);

static int ksd_relay_on_reply(const zmk_event_t *eh) {
    const struct ksd_relay_reply *reply = as_ksd_relay_reply(eh);
    if (reply == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (k_msgq_put(&ksd_relay_reply_msgq, reply, K_NO_WAIT) != 0) {
        LOG_WRN("kscan diagnostics relay reply queue full, dropping reply");
        return ZMK_EV_EVENT_BUBBLE;
    }
    k_work_submit_to_queue(&ksd_relay_workq, &ksd_relay_notify_work_item);
    return ZMK_EV_EVENT_HANDLED;
}

ZMK_LISTENER(ksd_relay_notify, ksd_relay_on_reply);
ZMK_SUBSCRIPTION(ksd_relay_notify, ksd_relay_reply);

#endif // CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC

/*
 * Central side entry point for the QueryPeripheral RPC (called from the Studio
 * handler): wrap the client's inner Request and broadcast it to all connected
 * peripherals, then acknowledge immediately. Replies arrive asynchronously via
 * ksd_relay_on_reply above.
 */
void ksd_relay_central_query(const cormoran_kscan_diagnostics_QueryPeripheral *req,
                             cormoran_kscan_diagnostics_Response *resp) {
    if (req->payload.size > KSD_RELAY_QUERY_DATA_MAX) {
        ksd_query_set_error(resp, "QueryPeripheral payload too large");
        return;
    }

    struct ksd_relay_query query = {
        .source = ZMK_RELAY_EVENT_SOURCE_SELF,
        .req_id = req->req_id,
        .len = (uint8_t)req->payload.size,
    };
    memcpy(query.data, req->payload.bytes, query.len);

    raise_ksd_relay_query(query);

    cormoran_kscan_diagnostics_Ok ok = cormoran_kscan_diagnostics_Ok_init_zero;
    resp->which_response_type = cormoran_kscan_diagnostics_Response_ok_tag;
    resp->response_type.ok = ok;
}

#endif // CONFIG_ZMK_SPLIT_ROLE_CENTRAL
