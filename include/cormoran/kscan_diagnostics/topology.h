/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <zephyr/device.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Which official ZMK kscan driver a leaf device is backed by. Values are part
 * of the RPC protocol (see cormoran.kscan_diagnostics.KscanDriverType) and
 * must stay in sync with kscan_diagnostics.proto.
 */
enum ksd_driver_type {
    KSD_DRIVER_UNKNOWN = 0,
    KSD_DRIVER_MATRIX = 1,
    KSD_DRIVER_DIRECT = 2,
    KSD_DRIVER_CHARLIEPLEX = 3,
    KSD_DRIVER_DEMUX = 4,
    KSD_DRIVER_MOCK = 5,
};

/**
 * Which role a GPIO line plays for a leaf device. Values are part of the RPC
 * protocol (see cormoran.kscan_diagnostics.GpioLineKind) and must stay in
 * sync with kscan_diagnostics.proto.
 */
enum ksd_gpio_kind {
    KSD_GPIO_KIND_UNKNOWN = 0,
    KSD_GPIO_KIND_ROW = 1,
    KSD_GPIO_KIND_COL = 2,
    KSD_GPIO_KIND_INPUT = 3,
    KSD_GPIO_KIND_OUTPUT = 4,
    KSD_GPIO_KIND_CHARLIE = 5,
};

/** One GPIO line belonging to a leaf kscan device. */
struct ksd_gpio_line {
    enum ksd_gpio_kind kind;
    /** Index within its kind (e.g. the Nth row-gpios entry). */
    uint8_t index;
    const char *port_name;
    uint8_t pin;
    bool active_low;
    uint32_t dt_flags;
};

/** Compile-time description of one leaf (non-wrapper) kscan device. */
struct ksd_device {
    const struct device *dev;
    const char *node_name;
    enum ksd_driver_type type;
    uint16_t rows;
    uint16_t columns;
    uint16_t inputs;
    uint16_t debounce_press_ms;
    uint16_t debounce_release_ms;
    uint16_t debounce_scan_period_ms;
    uint16_t poll_period_ms;
    bool diode_row2col;
    bool toggle_mode;
    const struct ksd_gpio_line *gpio_lines;
    size_t gpio_line_count;
};

/** One leaf device contributing to a physical layout's kscan, with offsets. */
struct ksd_layout_device {
    uint16_t leaf_index;
    int16_t row_offset;
    int16_t col_offset;
};

/** Compile-time description of one physical layout's kscan wiring. */
struct ksd_layout {
    const char *display_name;
    uint16_t rows;
    uint16_t columns;
    uint16_t key_count;
    const struct ksd_layout_device *devices;
    size_t device_count;
};

/** @return number of leaf kscan devices known at compile time (may be 0). */
size_t ksd_topology_device_count(void);

/**
 * @return the leaf device at @p index, or NULL if out of range.
 */
const struct ksd_device *ksd_topology_get_device(size_t index);

/** @return number of physical layouts known at compile time (may be 0). */
size_t ksd_topology_layout_count(void);

/**
 * @return the layout at @p index, or NULL if out of range.
 */
const struct ksd_layout *ksd_topology_get_layout(size_t index);

/**
 * @return index into ksd_topology_get_layout() of the currently selected
 * physical layout (0 if physical layout selection is unavailable).
 */
size_t ksd_topology_selected_layout(void);

/**
 * Compute the keymap position for a GLOBAL transform (row, column) in the
 * given layout. Local scan dimensions and origin do not restrict this map;
 * device wiring offsets identify which cells have locally known wiring.
 *
 * @retval >=0 the mapped position.
 * @retval -1 if the cell is unmapped or the layout index is out of range.
 */
int32_t ksd_topology_position_for_cell(size_t layout_index, uint32_t row, uint32_t column);

#ifdef __cplusplus
}
#endif
