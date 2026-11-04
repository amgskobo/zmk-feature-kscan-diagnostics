/* SPDX-License-Identifier: MIT */
#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/logging/log.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include <envelope.pb.h>
#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/query.h>
#include <cormoran/kscan_diagnostics/stats.h>
#include <cormoran/kscan_diagnostics/topology.h>
#include <cormoran/kscan_diagnostics/relay_events.h>
#include <zmk/studio/core.h>
#include <zmk/events/endpoint_changed.h>
#include <wired.h>

#define CHECK(value)                                                                               \
    do {                                                                                           \
        if (!(value)) {                                                                            \
            printk("FAIL line=%d: %s\n", __LINE__, #value);                                        \
            exit(1);                                                                               \
        }                                                                                          \
    } while (0)
DEVICE_DT_DEFINE(DT_NODELABEL(left_scan), NULL, NULL, NULL, NULL, POST_KERNEL, 0, NULL);
#if DT_NODE_EXISTS(DT_NODELABEL(right_scan))
DEVICE_DT_DEFINE(DT_NODELABEL(right_scan), NULL, NULL, NULL, NULL, POST_KERNEL, 0, NULL);
#endif
int zmk_physical_layouts_get_selected(void) { return 0; }
size_t ksd_stats_max_positions(void) { return 1; }
bool ksd_stats_get(size_t position, struct ksd_pos_stats *out) {
    if (position)
        return false;
    *out = (struct ksd_pos_stats){.presses = 123, .releases = 122};
    return true;
}
void ksd_stats_reset_all(void) {}
static enum zmk_studio_core_lock_state studio_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
enum zmk_studio_core_lock_state zmk_studio_core_get_lock_state(void) { return studio_state; }
ZMK_EVENT_IMPL(zmk_studio_core_lock_state_changed);
ZMK_EVENT_IMPL(zmk_endpoint_changed);
static void studio(bool unlocked) {
    studio_state =
        unlocked ? ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED : ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
    CHECK(raise_zmk_studio_core_lock_state_changed(
              (struct zmk_studio_core_lock_state_changed){.state = studio_state}) == 0);
}

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
#include <zmk/studio/custom.h>
struct zmk_rpc_custom_subsystem review_subsystems[1] = {{"cormoran__kscan_diagnostics"}};
ZMK_EVENT_IMPL(zmk_studio_custom_notification);
bool zmk_rpc_custom_subsystem_encode_response_payload(pb_ostream_t *s, const pb_field_t *f,
                                                      const pb_msgdesc_t *fields,
                                                      const void *value) {
    size_t size;
    return pb_encode_tag_for_field(s, f) && pb_get_encoded_size(&size, fields, value) &&
           pb_encode_varint(s, size) && pb_encode(s, fields, value);
}
#endif

#include RELAY_SOURCE

K_SEM_DEFINE(barrier_done, 0, 1);
static void barrier_fn(struct k_work *work) {
    ARG_UNUSED(work);
    k_sem_give(&barrier_done);
}
K_WORK_DEFINE(barrier_work, barrier_fn);
static void idle(void) {
    CHECK(k_work_submit_to_queue(&ksd_relay_workq, &barrier_work) >= 0);
    CHECK(k_sem_take(&barrier_done, K_SECONDS(1)) == 0);
}
K_SEM_DEFINE(gate_entered, 0, 1);
K_SEM_DEFINE(gate_release, 0, 1);
static void gate_fn(struct k_work *work) {
    ARG_UNUSED(work);
    k_sem_give(&gate_entered);
    CHECK(k_sem_take(&gate_release, K_SECONDS(1)) == 0);
}
K_WORK_DEFINE(gate_work, gate_fn);
static void block(void) {
    CHECK(k_work_submit_to_queue(&ksd_relay_workq, &gate_work) >= 0);
    CHECK(k_sem_take(&gate_entered, K_SECONDS(1)) == 0);
}
static void unblock(void) {
    k_sem_give(&gate_release);
    idle();
}

static void topology(void) {
    CHECK(sizeof(struct ksd_relay_query) == 38 && sizeof(struct ksd_relay_reply) == 198);
    CHECK(sizeof(struct ksd_relay_reply) <= 240);
    CHECK(sizeof(struct command_payload) <= UINT8_MAX && sizeof(struct event_payload) <= UINT8_MAX);
    size_t count = IS_ENABLED(REVIEW_FALLBACK) || IS_ENABLED(REVIEW_SCAN_ONLY) ? 1 : 2;
    CHECK(ksd_topology_layout_count() == count);
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    cormoran_kscan_diagnostics_Response resp = cormoran_kscan_diagnostics_Response_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_info_tag;
    ksd_query_dispatch(&req, &resp);
    CHECK(resp.response_type.info.layout_count == count);
    for (size_t layout_index = 0; layout_index < count; layout_index++) {
        const struct ksd_layout *layout = ksd_topology_get_layout(layout_index);
        CHECK(layout && layout->device_count == 1);
        const struct ksd_device *device = ksd_topology_get_device(layout->devices[0].leaf_index);
        CHECK(device && device->rows == 2 && device->columns == 2);
        bool right = IS_ENABLED(REVIEW_FALLBACK) || layout_index == 1;
        CHECK(layout->devices[0].row_offset == (right ? 1 : 0));
        CHECK(layout->devices[0].col_offset == (right ? 6 : 0));
        uint32_t rows = IS_ENABLED(REVIEW_SCAN_ONLY) ? 2 : 4;
        uint32_t columns = IS_ENABLED(REVIEW_SCAN_ONLY) ? 2 : 11;
        CHECK(layout->rows == rows && layout->columns == columns);
        const uint32_t map[] = {0x0000, 0x0001, 0x0100, 0x0101, 0x0106,
                                0x0107, 0x0206, 0x0207, 0x030a};
        for (uint32_t offset = 0; offset < rows * columns; offset += 24) {
            req.which_request_type = cormoran_kscan_diagnostics_Request_get_position_map_tag;
            req.request_type.get_position_map.layout_index = layout_index;
            req.request_type.get_position_map.offset = offset;
            ksd_query_dispatch(&req, &resp);
            CHECK(resp.which_response_type == cormoran_kscan_diagnostics_Response_position_map_tag);
            CHECK(resp.response_type.position_map.total == rows * columns);
            CHECK(resp.response_type.position_map.offset == offset);
            CHECK(resp.response_type.position_map.cells_count == MIN(24, rows * columns - offset));
            for (uint32_t i = 0; i < resp.response_type.position_map.cells_count; i++) {
                uint32_t row = (offset + i) / columns, column = (offset + i) % columns;
                int32_t expected = -1;
                if (IS_ENABLED(REVIEW_SCAN_ONLY))
                    expected = offset + i;
                else
                    for (size_t p = 0; p < ARRAY_SIZE(map); p++)
                        if (map[p] == ((row << 8) | column))
                            expected = p;
                CHECK(ksd_topology_position_for_cell(layout_index, row, column) == expected);
                CHECK(resp.response_type.position_map.cells[i] == expected + 1);
            }
        }
        CHECK(ksd_topology_position_for_cell(layout_index, rows, 0) == -1);
        CHECK(ksd_topology_position_for_cell(layout_index, 0, columns) == -1);
        CHECK(ksd_topology_position_for_cell(layout_index, UINT32_MAX, UINT32_MAX) == -1);
    }
    CHECK(ksd_topology_get_layout(count) == NULL);
    CHECK(ksd_topology_position_for_cell(count, 0, 0) == -1);
    printk("PASS topology full-grid offset edges and fallback\n");
}

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
static struct ksd_relay_query last_query;
static unsigned query_count, sent_count, rejected_count;
static cormoran_kscan_diagnostics_PeripheralEvent last_event;
static bool pause_send, lock_after_size;
K_SEM_DEFINE(send_entered, 0, 1);
K_SEM_DEFINE(send_release, 0, 1);
static int query_capture(const zmk_event_t *eh) {
    last_query = *as_ksd_relay_query(eh);
    query_count++;
    return ZMK_EV_EVENT_BUBBLE;
}
ZMK_LISTENER(query_capture, query_capture);
ZMK_SUBSCRIPTION(query_capture, ksd_relay_query);
struct capture {
    uint8_t bytes[256];
    size_t size;
};
static bool capture_payload(pb_istream_t *s, const pb_field_t *f, void **arg) {
    ARG_UNUSED(f);
    struct capture *capture = *arg;
    capture->size = s->bytes_left;
    return capture->size <= sizeof(capture->bytes) && pb_read(s, capture->bytes, capture->size);
}
static int notify_capture(const zmk_event_t *eh) {
    const struct zmk_studio_custom_notification *ev = as_zmk_studio_custom_notification(eh);
    if (pause_send) {
        pause_send = false;
        k_sem_give(&send_entered);
        CHECK(k_sem_take(&send_release, K_SECONDS(1)) == 0);
    }
    review_Envelope envelope = review_Envelope_init_zero;
    envelope.has_payload = true;
    envelope.payload.body = ev->encode_payload;
    size_t size;
    CHECK(pb_get_encoded_size(&size, review_Envelope_fields, &envelope));
    if (lock_after_size) {
        lock_after_size = false;
        studio(false);
    }
    uint8_t bytes[256];
    pb_ostream_t os = pb_ostream_from_buffer(bytes, sizeof(bytes));
    CHECK(pb_encode(&os, review_Envelope_fields, &envelope));
    CHECK(os.bytes_written == size);
    review_Envelope decoded = review_Envelope_init_zero;
    struct capture capture = {0};
    decoded.payload.body.funcs.decode = capture_payload;
    decoded.payload.body.arg = &capture;
    pb_istream_t is = pb_istream_from_buffer(bytes, os.bytes_written);
    CHECK(pb_decode(&is, review_Envelope_fields, &decoded) && is.bytes_left == 0);
    if (!capture.size) {
        rejected_count++;
        return ZMK_EV_EVENT_BUBBLE;
    }
    last_event = (cormoran_kscan_diagnostics_PeripheralEvent)
        cormoran_kscan_diagnostics_PeripheralEvent_init_zero;
    is = pb_istream_from_buffer(capture.bytes, capture.size);
    CHECK(pb_decode(&is, cormoran_kscan_diagnostics_PeripheralEvent_fields, &last_event));
    CHECK(last_event.req_id == UINT32_MAX && last_event.source >= 1);
    CHECK(last_event.payload.size == 1 && last_event.payload.bytes[0] == 0x7f);
    sent_count++;
    return ZMK_EV_EVENT_BUBBLE;
}
ZMK_LISTENER(notify_capture, notify_capture);
ZMK_SUBSCRIPTION(notify_capture, zmk_studio_custom_notification);
static uint32_t query(bool ok) {
    cormoran_kscan_diagnostics_QueryPeripheral req = {.req_id = UINT32_MAX};
    req.payload.size = 2;
    req.payload.bytes[0] = 0x32;
    req.payload.bytes[1] = 0;
    cormoran_kscan_diagnostics_Response resp = cormoran_kscan_diagnostics_Response_init_zero;
    unsigned before = query_count;
    ksd_relay_central_query(&req, &resp);
    CHECK(resp.which_response_type == (ok ? cormoran_kscan_diagnostics_Response_ok_tag
                                          : cormoran_kscan_diagnostics_Response_error_tag));
    CHECK(query_count == before + (ok ? 1 : 0));
    return last_query.req_id;
}
static void reply(uint32_t ticket, uint8_t source) {
    struct ksd_relay_reply reply = {.req_id = ticket, .source = source, .len = 1, .data = {0x7f}};
    CHECK(raise_ksd_relay_reply(reply) == 0);
}
static void relay(void) {
    uint32_t ticket = query(true);
    CHECK(ticket != 0 && ticket != UINT32_MAX);
    pause_send = true;
    reply(ticket, 1);
    CHECK(k_sem_take(&send_entered, K_SECONDS(1)) == 0);
    studio(false);
    studio(true);
    uint32_t replacement = query(true);
    CHECK(replacement != ticket);
    reply(ticket, 2);
    k_sem_give(&send_release);
    idle();
    CHECK(sent_count == 0 && rejected_count == 1);
    reply(replacement, 1);
    idle();
    CHECK(sent_count == 1);
    reply(replacement, 1);
    idle();
    CHECK(sent_count == 1);
    reply(replacement, 2);
    idle();
    CHECK(sent_count == 2);
    studio(false);
    studio(true);
    ticket = query(true);
    block();
    reply(ticket, 1);
    CHECK(k_msgq_num_used_get(&ksd_relay_reply_msgq) == 1);
    studio(false);
    studio(true);
    unblock();
    CHECK(sent_count == 2);
    ticket = query(true);
    block();
    reply(ticket, 1);
    CHECK(raise_zmk_endpoint_changed((struct zmk_endpoint_changed){0}) == 0);
    unblock();
    CHECK(sent_count == 2);
    ticket = query(true);
    k_sleep(K_MSEC(CONFIG_ZMK_KSCAN_DIAGNOSTICS_RELAY_TIMEOUT_MS + 20));
    reply(ticket, 1);
    idle();
    CHECK(sent_count == 2);
    ticket = query(true);
    lock_after_size = true;
    reply(ticket, 1);
    idle();
    CHECK(sent_count == 3); /* A committed sizing/output pair remains a valid frame. */
    query(IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED));
    studio(true);
    CHECK(raise_zmk_endpoint_changed((struct zmk_endpoint_changed){0}) == 0);
    for (size_t i = 0; i < ARRAY_SIZE(ksd_pending); i++)
        query(true);
    query(false);
    struct ksd_relay_reply_event bad = {
        .header.event = &zmk_event_ksd_relay_reply,
        .data = {.source = 1, .req_id = last_query.req_id, .len = KSD_RELAY_REPLY_DATA_MAX + 1}};
    CHECK(ksd_relay_on_reply(&bad.header) == ZMK_EV_EVENT_BUBBLE);
    k_sleep(K_MSEC(CONFIG_ZMK_KSCAN_DIAGNOSTICS_RELAY_TIMEOUT_MS + 20));
    query(true);
    printk("PASS relay authorization pending bounds duplicate deadline and encoder lifetime\n");
}
#else
static unsigned answer_count;
static struct ksd_relay_reply last_answer;
static int answer_capture(const zmk_event_t *eh) {
    last_answer = *as_ksd_relay_reply(eh);
    answer_count++;
    return ZMK_EV_EVENT_BUBBLE;
}
ZMK_LISTENER(answer_capture, answer_capture);
ZMK_SUBSCRIPTION(answer_capture, ksd_relay_reply);
static void relay(void) {
    struct ksd_relay_query_event event = {.header.event = &zmk_event_ksd_relay_query,
                                          .data = {.source = 0, .req_id = UINT32_MAX, .len = 33}};
    for (size_t i = 0; i < sizeof(event.data.data); i += 2) {
        event.data.data[i] = 0x78;
        event.data.data[i + 1] = 0;
    }
    block();
    CHECK(ksd_relay_on_query(&event.header) == ZMK_EV_EVENT_BUBBLE);
    CHECK(k_msgq_num_used_get(&ksd_relay_query_msgq) == 0);
    /* The worker independently defends against an invalid queued carrier. */
    CHECK(k_msgq_put(&ksd_relay_query_msgq, &event.data, K_NO_WAIT) == 0);
    CHECK(k_work_submit_to_queue(&ksd_relay_workq, &ksd_relay_answer_work_item) >= 0);
    unblock();
    CHECK(answer_count == 0);
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_info_tag;
    pb_ostream_t os = pb_ostream_from_buffer(event.data.data, sizeof(event.data.data));
    CHECK(pb_encode(&os, cormoran_kscan_diagnostics_Request_fields, &req));
    event.data.len = os.bytes_written;
    CHECK(ksd_relay_on_query(&event.header) == ZMK_EV_EVENT_HANDLED);
    idle();
    CHECK(answer_count == 1 && last_answer.req_id == UINT32_MAX);
    cormoran_kscan_diagnostics_Response response = cormoran_kscan_diagnostics_Response_init_zero;
    pb_istream_t is = pb_istream_from_buffer(last_answer.data, last_answer.len);
    CHECK(pb_decode(&is, cormoran_kscan_diagnostics_Response_fields, &response));
    CHECK(response.which_response_type == cormoran_kscan_diagnostics_Response_info_tag);
    CHECK(response.response_type.info.layout_count == ksd_topology_layout_count());
    printk("PASS relay inner length receive and worker bounds plus valid uint32 reply\n");
}
#endif

int main(void) {
    topology();
    relay();
    printk("PASS kscan review boundaries complete\n");
    exit(0);
}
