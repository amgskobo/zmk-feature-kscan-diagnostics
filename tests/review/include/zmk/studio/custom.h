#pragma once
#include <pb.h>
#include <pb_encode.h>
#include <zmk/event_manager.h>
struct zmk_rpc_custom_subsystem {
    const char *identifier;
};
extern struct zmk_rpc_custom_subsystem review_subsystems[1];
#undef STRUCT_SECTION_COUNT
#undef STRUCT_SECTION_GET
#define STRUCT_SECTION_COUNT(type, count) (*(count) = 1)
#define STRUCT_SECTION_GET(type, index, value) (*(value) = &review_subsystems[index])
bool zmk_rpc_custom_subsystem_encode_response_payload(pb_ostream_t *, const pb_field_t *,
                                                      const pb_msgdesc_t *, const void *);
struct zmk_studio_custom_notification {
    uint8_t subsystem_index;
    pb_callback_t encode_payload;
};
ZMK_EVENT_DECLARE(zmk_studio_custom_notification);
