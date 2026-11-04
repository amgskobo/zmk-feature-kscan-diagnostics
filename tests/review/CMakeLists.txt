cmake_minimum_required(VERSION 3.20.0)
list(APPEND DTS_ROOT "${ZMK_ROOT}/app")
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(kscan_review)
target_sources(app PRIVATE main.c logging.c "${OWNER_ROOT}/src/topology.c"
  "${OWNER_ROOT}/src/kscan_diagnostics_query.c"
  "${OWNER_ROOT}/src/split/kscan_diagnostics_relay_events.c"
  "${ZMK_ROOT}/app/src/event_manager.c"
  "${GENERATED_ROOT}/cormoran/kscan_diagnostics/kscan_diagnostics.pb.c"
  "${GENERATED_ROOT}/envelope.pb.c"
  "${NANOPB_ROOT}/pb_common.c" "${NANOPB_ROOT}/pb_encode.c" "${NANOPB_ROOT}/pb_decode.c")
target_include_directories(app PRIVATE include "${OWNER_ROOT}/include"
  "${GENERATED_ROOT}" "${NANOPB_ROOT}" "${ZMK_ROOT}/app/include"
  "${ZMK_ROOT}/app/src/split/wired")
target_compile_definitions(app PRIVATE
  RELAY_SOURCE="${OWNER_ROOT}/src/split/kscan_diagnostics_relay.c"
  CONFIG_ZMK_LOG_LEVEL=0 CONFIG_ZMK_KSCAN_DEBOUNCE_PRESS_MS=-1
  CONFIG_ZMK_KSCAN_DEBOUNCE_RELEASE_MS=-1 CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS=16
  CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT=1 CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=240
  CONFIG_ZMK_SPLIT_RELAY_EVENT=1 CONFIG_ZMK_SPLIT_RELAY_EVENT_TYPE_NAME_LEN=4
  CONFIG_ZMK_KSCAN_DIAGNOSTICS_RELAY_STACK_SIZE=8192
  CONFIG_ZMK_KSCAN_DIAGNOSTICS_RELAY_TIMEOUT_MS=100 PB_WITHOUT_64BIT=1)
if(REVIEW_CENTRAL)
  target_compile_definitions(app PRIVATE CONFIG_ZMK_SPLIT_ROLE_CENTRAL=1
    CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=1)
endif()
if(REVIEW_UNSECURED)
  target_compile_definitions(app PRIVATE CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_UNSECURED=1)
endif()
if(REVIEW_FALLBACK)
  target_compile_definitions(app PRIVATE REVIEW_FALLBACK=1)
endif()
if(REVIEW_SCAN_ONLY)
  target_compile_definitions(app PRIVATE REVIEW_SCAN_ONLY=1)
endif()
zephyr_linker_sources(RODATA "${ZMK_ROOT}/app/include/linker/zmk-events.ld")
