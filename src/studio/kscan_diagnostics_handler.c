/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/kernel.h>
#include <zmk/studio/custom.h>
#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/query.h>
#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT)
#include <cormoran/kscan_diagnostics/relay.h>
#endif

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

/*
 * No TX-buffer BUILD_ASSERT here: the Studio RPC streams the encoded Response
 * through a ring buffer with backpressure (SIZE_MAX pb_ostream in
 * app/src/studio/rpc.c), so a Response is not bounded by
 * CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE -- that knob only affects throughput. A
 * larger TX buffer (e.g. 256) is still recommended for responsiveness (see
 * the "Studio RPC TX buffer bottleneck" note) but is not a correctness
 * requirement. See the paging comment in src/kscan_diagnostics_query.c.
 */

static struct zmk_rpc_custom_subsystem_meta kscan_diagnostics_subsystem_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://cormoran.github.io/zmk-feature-kscan-diagnostics/"),
// Secured by default: diagnostics require an unlocked device. Topology and
// aggregate counters are not highly sensitive, so exposing them while
// locked is opt-in via CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED --
// useful in un-reliable environments where a broken keyboard may not be
// able to type the &studio_unlock combo (DESIGN.md SS2).
#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED)
    .security = ZMK_STUDIO_RPC_HANDLER_UNSECURED,
#else
    .security = ZMK_STUDIO_RPC_HANDLER_SECURED,
#endif
};

ZMK_RPC_CUSTOM_SUBSYSTEM(cormoran__kscan_diagnostics, &kscan_diagnostics_subsystem_meta,
                         kscan_diagnostics_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(cormoran__kscan_diagnostics,
                                         cormoran_kscan_diagnostics_Response);

static bool kscan_diagnostics_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                                 pb_callback_t *encode_response) {
    cormoran_kscan_diagnostics_Response *resp = ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(
        cormoran__kscan_diagnostics, encode_response);

    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;

    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, cormoran_kscan_diagnostics_Request_fields, &req)) {
        LOG_WRN("Failed to decode kscan_diagnostics request: %s", PB_GET_ERROR(&req_stream));
        ksd_query_set_error(resp, "Failed to decode request");
        return true;
    }

#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT)
    // QueryPeripheral is central-only relay plumbing: it wraps an inner
    // Request destined for the peripheral half, so it is not part of the
    // shared local dispatch. Intercept it here and relay; the peripheral's
    // reply is delivered later as a PeripheralEvent notification.
    if (req.which_request_type == cormoran_kscan_diagnostics_Request_query_peripheral_tag) {
        ksd_relay_central_query(&req.request_type.query_peripheral, resp);
        return true;
    }
#endif

    ksd_query_dispatch(&req, resp);
    return true;
}
