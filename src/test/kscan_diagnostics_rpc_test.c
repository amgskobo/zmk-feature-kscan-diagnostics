/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 *
 * native_sim self-test for src/studio/kscan_diagnostics_handler.c, run
 * against tests/studio/ (native_sim/native/zmk_test_mock board + ../test.dtsi
 * -- a real zmk,kscan-mock(rows=2,columns=2) device wired up as the chosen
 * zmk,kscan, with a matching 2x2 zmk,physical-layout + zmk,matrix-transform).
 * Drives the registered handler directly (no transport), the same pattern
 * zmk-feature-watchdog's src/test/watchdog_rpc_test.c uses.
 */

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zmk/studio/custom.h>
#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/relay_events.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

static custom_subsystem_handler *find_kscan_diagnostics_rpc_handler(void) {
    size_t count;
    STRUCT_SECTION_COUNT(zmk_rpc_custom_subsystem, &count);

    for (size_t i = 0; i < count; i++) {
        struct zmk_rpc_custom_subsystem *subsys;
        STRUCT_SECTION_GET(zmk_rpc_custom_subsystem, i, &subsys);
        if (strcmp(subsys->identifier, "cormoran__kscan_diagnostics") == 0) {
            return subsys->handler;
        }
    }
    return NULL;
}

/* Decode callback for zmk_custom_CallResponse.payload (a pb_callback_t bytes
 * field with no fixed max_size): copies the remaining raw bytes of this
 * submessage into a fixed test buffer, the standard nanopb pattern for
 * decoding a callback-typed bytes field. */
struct call_response_payload_capture {
    uint8_t buf[CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE + 16];
    size_t size;
};

static bool decode_call_response_payload(pb_istream_t *stream, const pb_field_t *field,
                                         void **arg) {
    ARG_UNUSED(field);
    struct call_response_payload_capture *capture = *arg;

    if (stream->bytes_left > sizeof(capture->buf)) {
        LOG_ERR("CallResponse payload too large for test capture buffer: %u",
                (unsigned int)stream->bytes_left);
        return false;
    }

    capture->size = stream->bytes_left;
    return pb_read(stream, capture->buf, capture->size);
}

/* Encodes req, calls the handler, decodes the response into *out. Returns
 * true on success (handler returned true and response decoded OK). */
static bool call_kscan_diagnostics_rpc(const cormoran_kscan_diagnostics_Request *req,
                                       cormoran_kscan_diagnostics_Response *out) {
    custom_subsystem_handler *handler = find_kscan_diagnostics_rpc_handler();
    if (!handler) {
        LOG_ERR("kscan_diagnostics RPC subsystem not registered");
        return false;
    }

    static zmk_custom_CallRequest raw_request;
    raw_request = (zmk_custom_CallRequest){0};
    pb_ostream_t req_stream =
        pb_ostream_from_buffer(raw_request.payload.bytes, sizeof(raw_request.payload.bytes));
    if (!pb_encode(&req_stream, cormoran_kscan_diagnostics_Request_fields, req)) {
        LOG_ERR("Failed to encode kscan_diagnostics request: %s", PB_GET_ERROR(&req_stream));
        return false;
    }
    raw_request.payload.size = req_stream.bytes_written;

    zmk_custom_CallResponse response = zmk_custom_CallResponse_init_zero;
    bool ok = handler(&raw_request, &response.payload);
    if (!ok || !response.payload.funcs.encode) {
        LOG_ERR("kscan_diagnostics RPC handler did not produce a response encoder");
        return false;
    }

    static uint8_t call_resp_buf[CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE + 16];
    pb_ostream_t call_resp_stream = pb_ostream_from_buffer(call_resp_buf, sizeof(call_resp_buf));
    if (!pb_encode(&call_resp_stream, zmk_custom_CallResponse_fields, &response)) {
        LOG_ERR("Failed to encode CallResponse: %s", PB_GET_ERROR(&call_resp_stream));
        return false;
    }

    static struct call_response_payload_capture capture;
    capture = (struct call_response_payload_capture){0};

    zmk_custom_CallResponse decoded_call_resp = zmk_custom_CallResponse_init_zero;
    decoded_call_resp.payload.funcs.decode = decode_call_response_payload;
    decoded_call_resp.payload.arg = &capture;

    pb_istream_t call_resp_istream =
        pb_istream_from_buffer(call_resp_buf, call_resp_stream.bytes_written);
    if (!pb_decode(&call_resp_istream, zmk_custom_CallResponse_fields, &decoded_call_resp)) {
        LOG_ERR("Failed to decode CallResponse: %s", PB_GET_ERROR(&call_resp_istream));
        return false;
    }

    *out = (cormoran_kscan_diagnostics_Response)cormoran_kscan_diagnostics_Response_init_zero;
    pb_istream_t resp_istream = pb_istream_from_buffer(capture.buf, capture.size);
    if (!pb_decode(&resp_istream, cormoran_kscan_diagnostics_Response_fields, out)) {
        LOG_ERR("Failed to decode kscan_diagnostics response: %s", PB_GET_ERROR(&resp_istream));
        return false;
    }

    return true;
}

static int test_rpc_get_info(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_info_tag;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_info_tag) {
        LOG_ERR("expected info response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Info *info = &resp.response_type.info;
    if (info->layout_count != 1 || info->device_count != 1 || info->stats_enabled != true ||
        info->max_positions != CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS) {
        LOG_ERR("unexpected Info: layout_count=%u device_count=%u stats_enabled=%d "
                "max_positions=%u",
                info->layout_count, info->device_count, info->stats_enabled, info->max_positions);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_info");
    return 0;
}

static int test_rpc_get_layout(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_layout_tag;
    req.request_type.get_layout.layout_index = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_layout_tag) {
        LOG_ERR("expected layout response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Layout *layout = &resp.response_type.layout;
    if (layout->rows != 2 || layout->columns != 2 || layout->key_count != 4) {
        LOG_ERR("unexpected Layout: rows=%u columns=%u key_count=%u", layout->rows, layout->columns,
                layout->key_count);
        return -EINVAL;
    }
    if (layout->device_indices_count != 1 || layout->device_indices[0].leaf_index != 0 ||
        layout->device_indices[0].row_offset != 0 || layout->device_indices[0].col_offset != 0) {
        LOG_ERR("unexpected Layout.device_indices: count=%u",
                (unsigned int)layout->device_indices_count);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_layout");
    return 0;
}

static int test_rpc_get_device(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_device_tag;
    req.request_type.get_device.device_index = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_device_tag) {
        LOG_ERR("expected device response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Device *device = &resp.response_type.device;
    if (device->type != cormoran_kscan_diagnostics_KscanDriverType_MOCK || device->rows != 2 ||
        device->columns != 2) {
        LOG_ERR("unexpected Device: type=%d rows=%u columns=%u", device->type, device->rows,
                device->columns);
        return -EINVAL;
    }
    if (strcmp(device->node_name, "native_posix_64_kscan_mock") != 0) {
        LOG_ERR("unexpected Device.node_name: %s", device->node_name);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_device");
    return 0;
}

static int test_rpc_get_gpio_pins_empty(void) {
    /* zmk,kscan-mock has no GPIO lines at all (rows/columns are descriptive
     * only -- see topology.c's zmk,kscan-mock block), so this must always
     * report an empty page regardless of requested kind. */
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_gpio_pins_tag;
    req.request_type.get_gpio_pins.device_index = 0;
    req.request_type.get_gpio_pins.kind = cormoran_kscan_diagnostics_GpioLineKind_KIND_UNKNOWN;
    req.request_type.get_gpio_pins.offset = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_gpio_pins_tag) {
        LOG_ERR("expected gpio_pins response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_GpioPins *pins = &resp.response_type.gpio_pins;
    if (pins->total != 0 || pins->pins_count != 0) {
        LOG_ERR("unexpected GpioPins: total=%u pins_count=%u", pins->total,
                (unsigned int)pins->pins_count);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_gpio_pins_empty");
    return 0;
}

static int test_rpc_get_position_map(void) {
    /* tests/test.dtsi's transform0.map is RC(0,0) RC(0,1) RC(1,0) RC(1,1),
     * i.e. row-major position order 0,1,2,3 -- position+1 encoding (0 =
     * unmapped) means the expected cells are 1,2,3,4. */
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_position_map_tag;
    req.request_type.get_position_map.layout_index = 0;
    req.request_type.get_position_map.offset = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_position_map_tag) {
        LOG_ERR("expected position_map response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_PositionMap *map = &resp.response_type.position_map;
    if (map->total != 4 || map->offset != 0 || map->cells_count != 4) {
        LOG_ERR("unexpected PositionMap: total=%u offset=%u cells_count=%u", map->total,
                map->offset, (unsigned int)map->cells_count);
        return -EINVAL;
    }
    static const uint32_t expected_cells[4] = {1, 2, 3, 4};
    for (size_t i = 0; i < ARRAY_SIZE(expected_cells); i++) {
        if (map->cells[i] != expected_cells[i]) {
            LOG_ERR("PositionMap.cells[%u] = %u, expected %u", (unsigned int)i, map->cells[i],
                    expected_cells[i]);
            return -EINVAL;
        }
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_position_map");
    return 0;
}

/*
 * ../test.dtsi scripts kscan mock events (see the comment there for the exact
 * timeline): position 0 (RC(0,0)) gets a press/release pair (~20ms nominal
 * hold), then a fast re-press with a ~30ms nominal release->press gap
 * (targeting the "<50ms" chatter bucket, which has the widest margin);
 * position 1 (RC(0,1)) gets a single press/release pair with no repress, to
 * prove counters are tracked independently per position. All events fire
 * within the first ~100ms of boot; kscan_diagnostics_rpc_test_init() sleeps
 * past that before asserting, so this must run after the sleep.
 *
 * CONFIG_NATIVE_SIM_SLOWDOWN_TO_REAL_TIME=y makes this a real wall-clock-timed
 * simulation (not instant), so exact millisecond assertions on
 * min_press_duration_ms / min_repress_gap_ms would be flaky; this asserts
 * tolerant ranges and bucket membership instead.
 */
static int test_rpc_get_stats(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_stats_tag;
    req.request_type.get_stats.offset = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_stats_tag) {
        LOG_ERR("expected stats response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Stats *stats = &resp.response_type.stats;
    if (stats->total != CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS || stats->offset != 0 ||
        stats->entries_count != 2) {
        LOG_ERR("unexpected Stats: total=%u offset=%u entries_count=%u", stats->total,
                stats->offset, (unsigned int)stats->entries_count);
        return -EINVAL;
    }

    const cormoran_kscan_diagnostics_PositionStats *pos0 = &stats->entries[0];
    if (pos0->position != 0 || pos0->presses != 2 || pos0->releases != 2 ||
        pos0->min_press_duration_ms < 10 || pos0->min_press_duration_ms > 40 ||
        pos0->min_repress_gap_ms < 20 || pos0->min_repress_gap_ms >= 50 || pos0->repress_lt5 != 0 ||
        pos0->repress_lt10 != 0 || pos0->repress_lt20 != 0 || pos0->repress_lt50 != 1 ||
        pos0->last_source != UINT8_MAX) {
        LOG_ERR("unexpected PositionStats[0]: presses=%u releases=%u min_press=%u min_gap=%u "
                "lt5=%u lt10=%u lt20=%u lt50=%u source=%u",
                pos0->presses, pos0->releases, pos0->min_press_duration_ms,
                pos0->min_repress_gap_ms, pos0->repress_lt5, pos0->repress_lt10, pos0->repress_lt20,
                pos0->repress_lt50, pos0->last_source);
        return -EINVAL;
    }

    const cormoran_kscan_diagnostics_PositionStats *pos1 = &stats->entries[1];
    if (pos1->position != 1 || pos1->presses != 1 || pos1->releases != 1 ||
        pos1->min_press_duration_ms < 10 || pos1->min_press_duration_ms > 40 ||
        pos1->min_repress_gap_ms != UINT16_MAX || pos1->repress_lt5 != 0 ||
        pos1->repress_lt10 != 0 || pos1->repress_lt20 != 0 || pos1->repress_lt50 != 0) {
        LOG_ERR("unexpected PositionStats[1]: presses=%u releases=%u min_press=%u min_gap=%u",
                pos1->presses, pos1->releases, pos1->min_press_duration_ms,
                pos1->min_repress_gap_ms);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_stats");
    return 0;
}

static int test_rpc_get_stats_offset(void) {
    /* offset=2 skips position 0 and 1 (both already exercised above); the
     * next entries are untouched positions, all-zero except the two
     * "no observation yet" sentinels. */
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_stats_tag;
    req.request_type.get_stats.offset = 2;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }
    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_stats_tag) {
        LOG_ERR("expected stats response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Stats *stats = &resp.response_type.stats;
    if (stats->offset != 2 || stats->entries_count != 2) {
        LOG_ERR("unexpected Stats page: offset=%u entries_count=%u", stats->offset,
                (unsigned int)stats->entries_count);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_PositionStats *pos2 = &stats->entries[0];
    if (pos2->position != 2 || pos2->presses != 0 || pos2->releases != 0 ||
        pos2->min_press_duration_ms != UINT16_MAX || pos2->min_repress_gap_ms != UINT16_MAX) {
        LOG_ERR("unexpected untouched PositionStats[2]: presses=%u releases=%u min_press=%u "
                "min_gap=%u",
                pos2->presses, pos2->releases, pos2->min_press_duration_ms,
                pos2->min_repress_gap_ms);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_stats_offset");
    return 0;
}

static int test_rpc_reset_stats(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_reset_stats_tag;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }
    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_ok_tag) {
        LOG_ERR("expected ok response for reset_stats, got %d", resp.which_response_type);
        return -EINVAL;
    }

    /* Verify the reset actually zeroed position 0's counters. */
    cormoran_kscan_diagnostics_Request get_req = cormoran_kscan_diagnostics_Request_init_zero;
    get_req.which_request_type = cormoran_kscan_diagnostics_Request_get_stats_tag;
    get_req.request_type.get_stats.offset = 0;

    cormoran_kscan_diagnostics_Response get_resp;
    if (!call_kscan_diagnostics_rpc(&get_req, &get_resp)) {
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_PositionStats *pos0 = &get_resp.response_type.stats.entries[0];
    if (pos0->presses != 0 || pos0->releases != 0 || pos0->min_press_duration_ms != UINT16_MAX ||
        pos0->min_repress_gap_ms != UINT16_MAX || pos0->repress_lt50 != 0) {
        LOG_ERR("unexpected PositionStats[0] after reset: presses=%u releases=%u min_press=%u "
                "min_gap=%u lt50=%u",
                pos0->presses, pos0->releases, pos0->min_press_duration_ms,
                pos0->min_repress_gap_ms, pos0->repress_lt50);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_reset_stats");
    return 0;
}

static int test_rpc_unknown_index_errors(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_device_tag;
    req.request_type.get_device.device_index = 99;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }
    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_error_tag) {
        LOG_ERR("expected error response for unknown device index, got %d",
                resp.which_response_type);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_unknown_index_errors");
    return 0;
}

/* Exercise the actual relay carrier types and nanopb event format, without a
 * split transport. IDs above 255 must survive both carriers and notification
 * encoding; otherwise a client cannot correlate a reply to its request. */
static int test_relay_request_id_roundtrip(void) {
    const uint32_t ids[] = {0, 255, 256, 0x12345678, UINT32_MAX};
    for (size_t i = 0; i < ARRAY_SIZE(ids); i++) {
        cormoran_kscan_diagnostics_QueryPeripheral request =
            cormoran_kscan_diagnostics_QueryPeripheral_init_zero;
        request.req_id = ids[i];
        struct ksd_relay_query sent = {.req_id = request.req_id};
        uint8_t query_wire[sizeof(sent)];
        memcpy(query_wire, &sent, sizeof(sent));
        struct ksd_relay_query received;
        memcpy(&received, query_wire, sizeof(received));

        struct ksd_relay_reply answer = {.req_id = received.req_id};
        uint8_t reply_wire[sizeof(answer)];
        memcpy(reply_wire, &answer, sizeof(answer));
        struct ksd_relay_reply reply;
        memcpy(&reply, reply_wire, sizeof(reply));

        cormoran_kscan_diagnostics_PeripheralEvent event =
            cormoran_kscan_diagnostics_PeripheralEvent_init_zero;
        event.req_id = reply.req_id;
        uint8_t encoded[16];
        pb_ostream_t output = pb_ostream_from_buffer(encoded, sizeof(encoded));
        if (!pb_encode(&output, cormoran_kscan_diagnostics_PeripheralEvent_fields, &event)) {
            return -EINVAL;
        }
        cormoran_kscan_diagnostics_PeripheralEvent decoded =
            cormoran_kscan_diagnostics_PeripheralEvent_init_zero;
        pb_istream_t input = pb_istream_from_buffer(encoded, output.bytes_written);
        if (!pb_decode(&input, cormoran_kscan_diagnostics_PeripheralEvent_fields, &decoded) ||
            decoded.req_id != ids[i]) {
            LOG_ERR("relay request ID changed: expected %u, got %u", ids[i], decoded.req_id);
            return -EINVAL;
        }
    }
    LOG_INF("PASS: kscan_diagnostics_relay_request_id_roundtrip");
    return 0;
}

static int kscan_diagnostics_rpc_test_init(void) {
    int ret = test_relay_request_id_roundtrip();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_info();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_layout();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_device();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_gpio_pins_empty();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_position_map();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_unknown_index_errors();
    if (ret < 0) {
        return ret;
    }

    /* ../test.dtsi's scripted kscan mock events all fire within the first
     * ~100ms of boot (see the comment above test_rpc_get_stats); sleep past
     * that so the stats listener has observed every scripted event before we
     * assert on it. */
    k_sleep(K_MSEC(300));

    ret = test_rpc_get_stats();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_stats_offset();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_reset_stats();
    if (ret < 0) {
        return ret;
    }

    return 0;
}

static int kscan_diagnostics_rpc_test_run(void) {
    int ret = kscan_diagnostics_rpc_test_init();

    /*
     * ../test.dtsi deletes &kscan's `exit-after` property (see the comment
     * there) precisely so nothing else terminates this process -- run-test.sh
     * has no timeout of its own and simply waits for zmk.exe's stdout to
     * close, so this test must call exit() itself once done, the same
     * pattern zmk-feature-watchdog's src/test/watchdog_test.c uses to end a
     * test that permanently wedges a workqueue. A LOG_ERR from a failing
     * assertion above has already been emitted by this point, so run-test.sh
     * (which only diffs stdout, not the process exit code) still reports the
     * mismatch correctly even though we unconditionally exit(0) here.
     */
    exit(ret < 0 ? 1 : 0);
    return 0; /* unreachable */
}

SYS_INIT(kscan_diagnostics_rpc_test_run, APPLICATION, 99);
