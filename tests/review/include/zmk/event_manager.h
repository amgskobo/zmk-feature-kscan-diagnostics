#pragma once
#include_next <zmk/event_manager.h>
/* Actual event dispatch remains; only physical split transport is controlled. */
#undef ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL
#undef ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL
#undef ZMK_RELAY_EVENT_HANDLE
#define ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL(...)
#define ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL(...)
#define ZMK_RELAY_EVENT_HANDLE(...)
