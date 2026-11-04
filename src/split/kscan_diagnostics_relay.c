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
#include <zmk/studio/core.h>
#include <zmk/events/endpoint_changed.h>
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
 * work queue has spare after the BLE receive path. To keep that allocation
 * off the sysworkq stack, the event listeners below only
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
        if (answer_query.len > sizeof(answer_query.data))
            continue;
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
    if (query->len > sizeof(query->data)) {
        LOG_WRN("Invalid kscan diagnostics relay query length");
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

struct ksd_pending_query {
    uint32_t wire_id;
    uint32_t client_id;
    int64_t deadline;
    uint8_t answered[32];
};
static struct k_spinlock ksd_relay_lock;
static struct ksd_pending_query ksd_pending[4];
static uint32_t ksd_relay_epoch;
static uint32_t ksd_next_wire_id;

static bool ksd_relay_authorized(void) {
    return IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED) ||
           zmk_studio_core_get_lock_state() == ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
}

struct ksd_queued_reply {
    struct ksd_relay_reply reply;
    uint32_t epoch;
    int64_t deadline;
};
K_MSGQ_DEFINE(ksd_relay_reply_msgq, sizeof(struct ksd_queued_reply), 4, 4);

struct ksd_event_encoding {
    cormoran_kscan_diagnostics_PeripheralEvent event;
    uint32_t epoch;
    int64_t deadline;
    bool decided;
    bool allowed;
};

static bool ksd_reply_current(uint32_t epoch, int64_t deadline) {
    k_spinlock_key_t key = k_spin_lock(&ksd_relay_lock);
    bool current = epoch == ksd_relay_epoch && deadline > k_uptime_get() && ksd_relay_authorized();
    k_spin_unlock(&ksd_relay_lock, key);
    return current;
}

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
    struct ksd_event_encoding *encoding = *arg;
    /* Decide after the transport wait, at the first sizing pass. Preserve that
     * decision during output so revocation cannot truncate a Studio frame. */
    if (!encoding->decided) {
        encoding->allowed = ksd_reply_current(encoding->epoch, encoding->deadline);
        encoding->decided = true;
    }
    if (!encoding->allowed)
        return true;
    return zmk_rpc_custom_subsystem_encode_response_payload(
        stream, field, cormoran_kscan_diagnostics_PeripheralEvent_fields, &encoding->event);
}

static struct ksd_queued_reply notify_reply;
static struct ksd_event_encoding notify_encoding;

static void ksd_relay_notify_work(struct k_work *work) {
    while (k_msgq_get(&ksd_relay_reply_msgq, &notify_reply, K_NO_WAIT) == 0) {
        if (!ksd_reply_current(notify_reply.epoch, notify_reply.deadline))
            continue;
        int index = ksd_relay_subsystem_index();
        if (index < 0) {
            LOG_WRN("kscan diagnostics subsystem not registered, dropping peripheral reply");
            continue;
        }

        notify_encoding = (struct ksd_event_encoding){
            .epoch = notify_reply.epoch,
            .deadline = notify_reply.deadline,
        };
        notify_encoding.event.source = notify_reply.reply.source;
        notify_encoding.event.req_id = notify_reply.reply.req_id;
        notify_encoding.event.payload.size = notify_reply.reply.len;
        memcpy(notify_encoding.event.payload.bytes, notify_reply.reply.data,
               notify_encoding.event.payload.size);

        // encode_payload runs inline within raise_zmk_studio_custom_notification,
        // so pointing at the static event/authorization record is safe.
        raise_zmk_studio_custom_notification((struct zmk_studio_custom_notification){
            .subsystem_index = (uint8_t)index,
            .encode_payload =
                {
                    .funcs.encode = ksd_relay_encode_peripheral_event,
                    .arg = &notify_encoding,
                },
        });
    }
}

static K_WORK_DEFINE(ksd_relay_notify_work_item, ksd_relay_notify_work);

static int ksd_relay_on_reply(const zmk_event_t *eh) {
    const struct ksd_relay_reply *reply = as_ksd_relay_reply(eh);
    if (reply == NULL || reply->len > sizeof(reply->data) || reply->source == 0 ||
        reply->source == ZMK_RELAY_EVENT_SOURCE_SELF) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    bool queued = false;
    k_spinlock_key_t key = k_spin_lock(&ksd_relay_lock);
    for (size_t i = 0; ksd_relay_authorized() && i < ARRAY_SIZE(ksd_pending); i++) {
        struct ksd_pending_query *pending = &ksd_pending[i];
        uint8_t bit = BIT(reply->source % 8);
        if (pending->wire_id != reply->req_id || pending->deadline <= k_uptime_get() ||
            (pending->answered[reply->source / 8] & bit))
            continue;
        struct ksd_queued_reply item = {
            .reply = *reply,
            .epoch = ksd_relay_epoch,
            .deadline = pending->deadline,
        };
        item.reply.req_id = pending->client_id;
        queued = k_msgq_put(&ksd_relay_reply_msgq, &item, K_NO_WAIT) == 0;
        if (queued)
            pending->answered[reply->source / 8] |= bit;
        break;
    }
    k_spin_unlock(&ksd_relay_lock, key);
    if (queued)
        k_work_submit_to_queue(&ksd_relay_workq, &ksd_relay_notify_work_item);
    return queued ? ZMK_EV_EVENT_HANDLED : ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(ksd_relay_notify, ksd_relay_on_reply);
ZMK_SUBSCRIPTION(ksd_relay_notify, ksd_relay_reply);

static int ksd_relay_on_authorization(const zmk_event_t *eh) {
    const struct zmk_studio_core_lock_state_changed *lock =
        as_zmk_studio_core_lock_state_changed(eh);
    if (!as_zmk_endpoint_changed(eh) &&
        !(lock && lock->state != ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED))
        return ZMK_EV_EVENT_BUBBLE;
    k_spinlock_key_t key = k_spin_lock(&ksd_relay_lock);
    ksd_relay_epoch++;
    memset(ksd_pending, 0, sizeof(ksd_pending));
    k_msgq_purge(&ksd_relay_reply_msgq);
    k_spin_unlock(&ksd_relay_lock, key);
    return ZMK_EV_EVENT_BUBBLE;
}
ZMK_LISTENER(ksd_relay_authorization, ksd_relay_on_authorization);
ZMK_SUBSCRIPTION(ksd_relay_authorization, zmk_studio_core_lock_state_changed);
ZMK_SUBSCRIPTION(ksd_relay_authorization, zmk_endpoint_changed);

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
        .len = (uint8_t)req->payload.size,
    };
#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC)
    k_spinlock_key_t key = k_spin_lock(&ksd_relay_lock);
    for (size_t i = 0; ksd_relay_authorized() && i < ARRAY_SIZE(ksd_pending); i++) {
        if (ksd_pending[i].wire_id && ksd_pending[i].deadline > k_uptime_get())
            continue;
        if (++ksd_next_wire_id == 0)
            ++ksd_next_wire_id;
        ksd_pending[i] = (struct ksd_pending_query){
            .wire_id = ksd_next_wire_id,
            .client_id = req->req_id,
            .deadline = k_uptime_get() + CONFIG_ZMK_KSCAN_DIAGNOSTICS_RELAY_TIMEOUT_MS,
        };
        query.req_id = ksd_next_wire_id;
        break;
    }
    k_spin_unlock(&ksd_relay_lock, key);
#endif
    if (query.req_id == 0) {
        ksd_query_set_error(resp, "Relay locked or too many pending queries");
        return;
    }
    memcpy(query.data, req->payload.bytes, query.len);

    raise_ksd_relay_query(query);

    cormoran_kscan_diagnostics_Ok ok = cormoran_kscan_diagnostics_Ok_init_zero;
    resp->which_response_type = cormoran_kscan_diagnostics_Response_ok_tag;
    resp->response_type.ok = ok;
}

#endif // CONFIG_ZMK_SPLIT_ROLE_CENTRAL
