/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 *
 * Compile-time DT tables describing kscan topology (DESIGN.md SS4). No kscan
 * driver exposes a runtime API for its wiring, so every field here is
 * extracted from devicetree at compile time, mirroring the macro logic each
 * driver itself uses in dependencies/zmk/app/module/drivers/kscan/*.c.
 *
 * Zero-device rule: when no kscan compat is okay in the build, every table
 * below is empty and every accessor returns 0 -- this file (and the RPC
 * handler on top of it) must still compile and run under native_sim.
 */

#include <cormoran/kscan_diagnostics/topology.h>

#include <zephyr/devicetree.h>
#include <zephyr/devicetree/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zmk/physical_layouts.h>
#include <zmk/matrix.h>

/*
 * ---------------------------------------------------------------------------
 * Debounce macros, replicated per-compat from the corresponding driver so we
 * read the exact same effective value it configured itself with (DT property
 * vs. deprecated debounce-period vs. Kconfig override).
 * ---------------------------------------------------------------------------
 */

#if CONFIG_ZMK_KSCAN_DEBOUNCE_PRESS_MS >= 0
#define KSD_DEBOUNCE_PRESS_MS(n) CONFIG_ZMK_KSCAN_DEBOUNCE_PRESS_MS
#else
#define KSD_DEBOUNCE_PRESS_MS(n) DT_PROP_OR(n, debounce_period, DT_PROP(n, debounce_press_ms))
#endif

#if CONFIG_ZMK_KSCAN_DEBOUNCE_RELEASE_MS >= 0
#define KSD_DEBOUNCE_RELEASE_MS(n) CONFIG_ZMK_KSCAN_DEBOUNCE_RELEASE_MS
#else
#define KSD_DEBOUNCE_RELEASE_MS(n) DT_PROP_OR(n, debounce_period, DT_PROP(n, debounce_release_ms))
#endif

/*
 * ---------------------------------------------------------------------------
 * GPIO line helper: build a struct ksd_gpio_line array entry for line `idx`
 * of property `prop` on node `n`, tagged with `kind_`.
 * ---------------------------------------------------------------------------
 */

#define KSD_GPIO_LINE_INIT(n, prop, idx, kind_)                                                    \
    {                                                                                              \
        .kind = kind_,                                                                             \
        .index = idx,                                                                              \
        .port_name = DEVICE_DT_NAME(DT_GPIO_CTLR_BY_IDX(n, prop, idx)),                            \
        .pin = DT_GPIO_PIN_BY_IDX(n, prop, idx),                                                   \
        .active_low = (DT_GPIO_FLAGS_BY_IDX(n, prop, idx) & GPIO_ACTIVE_LOW) == GPIO_ACTIVE_LOW,   \
        .dt_flags = DT_GPIO_FLAGS_BY_IDX(n, prop, idx),                                            \
    }

/*
 * ===========================================================================
 * zmk,kscan-gpio-matrix
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_gpio_matrix)

#define KSD_MATRIX_ROW2COL(n) (DT_ENUM_IDX(n, diode_direction) == 0)

#define KSD_MATRIX_ROW_LINE(idx, n) KSD_GPIO_LINE_INIT(n, row_gpios, idx, KSD_GPIO_KIND_ROW)
#define KSD_MATRIX_COL_LINE(idx, n) KSD_GPIO_LINE_INIT(n, col_gpios, idx, KSD_GPIO_KIND_COL)

#define KSD_MATRIX_ENTRY(n)                                                                        \
    static const struct ksd_gpio_line ksd_matrix_lines_##n[] = {                                   \
        LISTIFY(DT_PROP_LEN(n, row_gpios), KSD_MATRIX_ROW_LINE, (, ), n),                          \
        LISTIFY(DT_PROP_LEN(n, col_gpios), KSD_MATRIX_COL_LINE, (, ), n),                          \
    };                                                                                             \
    static const struct ksd_device ksd_matrix_device_##n = {                                       \
        .dev = DEVICE_DT_GET(n),                                                                   \
        .node_name = DT_NODE_FULL_NAME(n),                                                         \
        .type = KSD_DRIVER_MATRIX,                                                                 \
        .rows = DT_PROP_LEN(n, row_gpios),                                                         \
        .columns = DT_PROP_LEN(n, col_gpios),                                                      \
        .inputs = KSD_MATRIX_ROW2COL(n) ? DT_PROP_LEN(n, col_gpios) : DT_PROP_LEN(n, row_gpios),   \
        .debounce_press_ms = KSD_DEBOUNCE_PRESS_MS(n),                                             \
        .debounce_release_ms = KSD_DEBOUNCE_RELEASE_MS(n),                                         \
        .debounce_scan_period_ms = DT_PROP(n, debounce_scan_period_ms),                            \
        .poll_period_ms = DT_PROP(n, poll_period_ms),                                              \
        .diode_row2col = KSD_MATRIX_ROW2COL(n),                                                    \
        .toggle_mode = false,                                                                      \
        .gpio_lines = ksd_matrix_lines_##n,                                                        \
        .gpio_line_count = ARRAY_SIZE(ksd_matrix_lines_##n),                                       \
    };

DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_matrix, KSD_MATRIX_ENTRY)

#define KSD_MATRIX_DEVICE_REF(n) &ksd_matrix_device_##n,
static const struct ksd_device *const ksd_matrix_devices[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_matrix, KSD_MATRIX_DEVICE_REF)};
#define KSD_MATRIX_DEVICE_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_gpio_matrix)

#else
#define KSD_MATRIX_DEVICE_COUNT 0
#endif

/*
 * ===========================================================================
 * zmk,kscan-gpio-direct
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_gpio_direct)

#define KSD_DIRECT_HAS_GPIOS(n) DT_NODE_HAS_PROP(n, input_gpios)

#define KSD_DIRECT_GPIO_LINE(idx, n) KSD_GPIO_LINE_INIT(n, input_gpios, idx, KSD_GPIO_KIND_INPUT)
/*
 * input-keys entries are phandles to gpio-keys "key" nodes; each such node
 * has its own single-entry `gpios` property (index 0), see kscan_gpio_direct.c
 * KSCAN_KEY_DIRECT_INPUT_CFG_INIT.
 */
#define KSD_DIRECT_KEY_LINE(idx, n)                                                                \
    KSD_GPIO_LINE_INIT(DT_PHANDLE_BY_IDX(n, input_keys, idx), gpios, 0, KSD_GPIO_KIND_INPUT)

#define KSD_DIRECT_INPUTS_LEN(n)                                                                   \
    COND_CODE_1(KSD_DIRECT_HAS_GPIOS(n), (DT_PROP_LEN(n, input_gpios)),                            \
                (DT_PROP_LEN(n, input_keys)))

#define KSD_DIRECT_ENTRY(n)                                                                        \
    static const struct ksd_gpio_line ksd_direct_lines_##n[] = {                                   \
        COND_CODE_1(KSD_DIRECT_HAS_GPIOS(n),                                                       \
                    (LISTIFY(KSD_DIRECT_INPUTS_LEN(n), KSD_DIRECT_GPIO_LINE, (, ), n)),            \
                    (LISTIFY(KSD_DIRECT_INPUTS_LEN(n), KSD_DIRECT_KEY_LINE, (, ), n)))};           \
    static const struct ksd_device ksd_direct_device_##n = {                                       \
        .dev = DEVICE_DT_GET(n),                                                                   \
        .node_name = DT_NODE_FULL_NAME(n),                                                         \
        .type = KSD_DRIVER_DIRECT,                                                                 \
        .rows = 1,                                                                                 \
        .columns = KSD_DIRECT_INPUTS_LEN(n),                                                       \
        .inputs = KSD_DIRECT_INPUTS_LEN(n),                                                        \
        .debounce_press_ms = KSD_DEBOUNCE_PRESS_MS(n),                                             \
        .debounce_release_ms = KSD_DEBOUNCE_RELEASE_MS(n),                                         \
        .debounce_scan_period_ms = DT_PROP(n, debounce_scan_period_ms),                            \
        .poll_period_ms = DT_PROP(n, poll_period_ms),                                              \
        .diode_row2col = false,                                                                    \
        .toggle_mode = DT_PROP(n, toggle_mode),                                                    \
        .gpio_lines = ksd_direct_lines_##n,                                                        \
        .gpio_line_count = ARRAY_SIZE(ksd_direct_lines_##n),                                       \
    };

DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_direct, KSD_DIRECT_ENTRY)

#define KSD_DIRECT_DEVICE_REF(n) &ksd_direct_device_##n,
static const struct ksd_device *const ksd_direct_devices[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_direct, KSD_DIRECT_DEVICE_REF)};
#define KSD_DIRECT_DEVICE_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_gpio_direct)

#else
#define KSD_DIRECT_DEVICE_COUNT 0
#endif

/*
 * ===========================================================================
 * zmk,kscan-gpio-charlieplex
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_gpio_charlieplex)

#define KSD_CHARLIE_LINE(idx, n) KSD_GPIO_LINE_INIT(n, gpios, idx, KSD_GPIO_KIND_CHARLIE)

#define KSD_CHARLIE_ENTRY(n)                                                                       \
    static const struct ksd_gpio_line ksd_charlie_lines_##n[] = {                                  \
        LISTIFY(DT_PROP_LEN(n, gpios), KSD_CHARLIE_LINE, (, ), n)};                                \
    static const struct ksd_device ksd_charlie_device_##n = {                                      \
        .dev = DEVICE_DT_GET(n),                                                                   \
        .node_name = DT_NODE_FULL_NAME(n),                                                         \
        .type = KSD_DRIVER_CHARLIEPLEX,                                                            \
        .rows = DT_PROP_LEN(n, gpios),                                                             \
        .columns = DT_PROP_LEN(n, gpios),                                                          \
        .inputs = DT_PROP_LEN(n, gpios),                                                           \
        .debounce_press_ms = KSD_DEBOUNCE_PRESS_MS(n),                                             \
        .debounce_release_ms = KSD_DEBOUNCE_RELEASE_MS(n),                                         \
        .debounce_scan_period_ms = DT_PROP(n, debounce_scan_period_ms),                            \
        .poll_period_ms = DT_PROP_OR(n, poll_period_ms, 1),                                        \
        .diode_row2col = false,                                                                    \
        .toggle_mode = false,                                                                      \
        .gpio_lines = ksd_charlie_lines_##n,                                                       \
        .gpio_line_count = ARRAY_SIZE(ksd_charlie_lines_##n),                                      \
    };

DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_charlieplex, KSD_CHARLIE_ENTRY)

#define KSD_CHARLIE_DEVICE_REF(n) &ksd_charlie_device_##n,
static const struct ksd_device *const ksd_charlie_devices[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_charlieplex, KSD_CHARLIE_DEVICE_REF)};
#define KSD_CHARLIE_DEVICE_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_gpio_charlieplex)

#else
#define KSD_CHARLIE_DEVICE_COUNT 0
#endif

/*
 * ===========================================================================
 * zmk,kscan-gpio-demux
 *
 * NOTE: this driver's Kconfig-vs-DT debounce override does not exist (it has
 * a single `debounce-period` property, always read directly from DT -- see
 * kscan_gpio_demux.c CHECK_DEBOUNCE_CFG) and its scan-interval property is
 * spelled `polling-interval-msec`, unlike every other driver's
 * `poll-period-ms`.
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_gpio_demux)

#define KSD_DEMUX_INPUT_LINE(idx, n) KSD_GPIO_LINE_INIT(n, input_gpios, idx, KSD_GPIO_KIND_INPUT)
#define KSD_DEMUX_OUTPUT_LINE(idx, n) KSD_GPIO_LINE_INIT(n, output_gpios, idx, KSD_GPIO_KIND_OUTPUT)

#define KSD_DEMUX_ENTRY(n)                                                                         \
    static const struct ksd_gpio_line ksd_demux_lines_##n[] = {                                    \
        LISTIFY(DT_PROP_LEN(n, input_gpios), KSD_DEMUX_INPUT_LINE, (, ), n),                       \
        LISTIFY(DT_PROP_LEN(n, output_gpios), KSD_DEMUX_OUTPUT_LINE, (, ), n),                     \
    };                                                                                             \
    static const struct ksd_device ksd_demux_device_##n = {                                        \
        .dev = DEVICE_DT_GET(n),                                                                   \
        .node_name = DT_NODE_FULL_NAME(n),                                                         \
        .type = KSD_DRIVER_DEMUX,                                                                  \
        .rows = DT_PROP_LEN(n, input_gpios),                                                       \
        .columns = (1U << DT_PROP_LEN(n, output_gpios)),                                           \
        .inputs = DT_PROP_LEN(n, input_gpios),                                                     \
        .debounce_press_ms = DT_PROP(n, debounce_period),                                          \
        .debounce_release_ms = DT_PROP(n, debounce_period),                                        \
        .debounce_scan_period_ms = 0,                                                              \
        .poll_period_ms = DT_PROP(n, polling_interval_msec),                                       \
        .diode_row2col = true,                                                                     \
        .toggle_mode = false,                                                                      \
        .gpio_lines = ksd_demux_lines_##n,                                                         \
        .gpio_line_count = ARRAY_SIZE(ksd_demux_lines_##n),                                        \
    };

DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_demux, KSD_DEMUX_ENTRY)

#define KSD_DEMUX_DEVICE_REF(n) &ksd_demux_device_##n,
static const struct ksd_device *const ksd_demux_devices[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_gpio_demux, KSD_DEMUX_DEVICE_REF)};
#define KSD_DEMUX_DEVICE_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_gpio_demux)

#else
#define KSD_DEMUX_DEVICE_COUNT 0
#endif

/*
 * ===========================================================================
 * zmk,kscan-mock -- rows/columns are descriptive-only DT properties, never
 * read by the driver itself (see kscan_mock.c); we surface them as-is,
 * defaulting to 0 when absent.
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_mock)

#define KSD_MOCK_ENTRY(n)                                                                          \
    static const struct ksd_device ksd_mock_device_##n = {                                         \
        .dev = DEVICE_DT_GET(n),                                                                   \
        .node_name = DT_NODE_FULL_NAME(n),                                                         \
        .type = KSD_DRIVER_MOCK,                                                                   \
        .rows = DT_PROP_OR(n, rows, 0),                                                            \
        .columns = DT_PROP_OR(n, columns, 0),                                                      \
        .inputs = 0,                                                                               \
        .debounce_press_ms = 0,                                                                    \
        .debounce_release_ms = 0,                                                                  \
        .debounce_scan_period_ms = 0,                                                              \
        .poll_period_ms = 0,                                                                       \
        .diode_row2col = false,                                                                    \
        .toggle_mode = false,                                                                      \
        .gpio_lines = NULL,                                                                        \
        .gpio_line_count = 0,                                                                      \
    };

DT_FOREACH_STATUS_OKAY(zmk_kscan_mock, KSD_MOCK_ENTRY)

#define KSD_MOCK_DEVICE_REF(n) &ksd_mock_device_##n,
static const struct ksd_device *const ksd_mock_devices[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_mock, KSD_MOCK_DEVICE_REF)};
#define KSD_MOCK_DEVICE_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_mock)

#else
#define KSD_MOCK_DEVICE_COUNT 0
#endif

/*
 * ===========================================================================
 * Leaf device table: concatenation of all per-compat tables above, in a
 * stable order. Index into this table is what the RPC protocol calls
 * `device_index` / `leaf_index`.
 * ===========================================================================
 */

#define KSD_LEAF_DEVICE_COUNT                                                                      \
    (KSD_MATRIX_DEVICE_COUNT + KSD_DIRECT_DEVICE_COUNT + KSD_CHARLIE_DEVICE_COUNT +                \
     KSD_DEMUX_DEVICE_COUNT + KSD_MOCK_DEVICE_COUNT)

#if KSD_LEAF_DEVICE_COUNT > 0
static const struct ksd_device *ksd_leaf_devices[KSD_LEAF_DEVICE_COUNT];
static bool ksd_leaf_devices_ready;

static void ksd_leaf_devices_init(void) {
    if (ksd_leaf_devices_ready) {
        return;
    }
    size_t i = 0;
#if KSD_MATRIX_DEVICE_COUNT > 0
    for (size_t j = 0; j < KSD_MATRIX_DEVICE_COUNT; j++) {
        ksd_leaf_devices[i++] = ksd_matrix_devices[j];
    }
#endif
#if KSD_DIRECT_DEVICE_COUNT > 0
    for (size_t j = 0; j < KSD_DIRECT_DEVICE_COUNT; j++) {
        ksd_leaf_devices[i++] = ksd_direct_devices[j];
    }
#endif
#if KSD_CHARLIE_DEVICE_COUNT > 0
    for (size_t j = 0; j < KSD_CHARLIE_DEVICE_COUNT; j++) {
        ksd_leaf_devices[i++] = ksd_charlie_devices[j];
    }
#endif
#if KSD_DEMUX_DEVICE_COUNT > 0
    for (size_t j = 0; j < KSD_DEMUX_DEVICE_COUNT; j++) {
        ksd_leaf_devices[i++] = ksd_demux_devices[j];
    }
#endif
#if KSD_MOCK_DEVICE_COUNT > 0
    for (size_t j = 0; j < KSD_MOCK_DEVICE_COUNT; j++) {
        ksd_leaf_devices[i++] = ksd_mock_devices[j];
    }
#endif
    ARG_UNUSED(i);
    ksd_leaf_devices_ready = true;
}
#else
static inline void ksd_leaf_devices_init(void) {}
#endif

size_t ksd_topology_device_count(void) { return KSD_LEAF_DEVICE_COUNT; }

const struct ksd_device *ksd_topology_get_device(size_t index) {
    if (index >= KSD_LEAF_DEVICE_COUNT) {
        return NULL;
    }
    ksd_leaf_devices_init();
#if KSD_LEAF_DEVICE_COUNT > 0
    return ksd_leaf_devices[index];
#else
    return NULL;
#endif
}

/** Find the leaf index for a resolved device pointer, or -1 if not found. */
static int32_t ksd_leaf_index_for_device(const struct device *dev) {
    if (dev == NULL) {
        return -1;
    }
    ksd_leaf_devices_init();
    for (size_t i = 0; i < KSD_LEAF_DEVICE_COUNT; i++) {
#if KSD_LEAF_DEVICE_COUNT > 0
        if (ksd_leaf_devices[i]->dev == dev) {
            return (int32_t)i;
        }
#endif
    }
    return -1;
}

/*
 * ===========================================================================
 * zmk,kscan-composite: resolve each wrapper instance's children to
 * (leaf_index, row_offset, col_offset) triples. Children are DT child nodes
 * with a `kscan` phandle to an already-instantiated leaf device (see
 * kscan_composite.c CHILD_CONFIG / DT_INST_FOREACH_CHILD).
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_composite)

/* Scratch capacity for resolving a nested wrapper child (e.g. composite
 * wrapping a sideband-behaviors device); no official binding nests deeper
 * than one extra hop, but a small buffer keeps this robust either way. */
#define KSD_COMPOSITE_NESTED_MAX 8

struct ksd_composite_child {
    const struct device *kscan;
    int16_t row_offset;
    int16_t col_offset;
};

#define KSD_COMPOSITE_CHILD(child)                                                                 \
    {                                                                                              \
        .kscan = DEVICE_DT_GET(DT_PHANDLE(child, kscan)),                                          \
        .row_offset = DT_PROP(child, row_offset),                                                  \
        .col_offset = DT_PROP_OR(child, col_offset, DT_PROP_OR(child, column_offset, 0)),          \
    },

#define KSD_COMPOSITE_ENTRY(n)                                                                     \
    static const struct ksd_composite_child ksd_composite_children_##n[] = {                       \
        DT_FOREACH_CHILD(n, KSD_COMPOSITE_CHILD)};                                                 \
    static const struct device *const ksd_composite_dev_##n = DEVICE_DT_GET(n);

DT_FOREACH_STATUS_OKAY(zmk_kscan_composite, KSD_COMPOSITE_ENTRY)

struct ksd_composite_wrapper {
    const struct device *wrapper;
    const struct ksd_composite_child *children;
    size_t child_count;
};

#define KSD_COMPOSITE_WRAPPER_REF(n)                                                               \
    {                                                                                              \
        .wrapper = ksd_composite_dev_##n,                                                          \
        .children = ksd_composite_children_##n,                                                    \
        .child_count = ARRAY_SIZE(ksd_composite_children_##n),                                     \
    },

static const struct ksd_composite_wrapper ksd_composite_wrappers[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_composite, KSD_COMPOSITE_WRAPPER_REF)};
#define KSD_COMPOSITE_WRAPPER_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_composite)

#else
#define KSD_COMPOSITE_WRAPPER_COUNT 0
#endif

/*
 * ===========================================================================
 * zmk,kscan-sideband-behaviors: maps a wrapper device to its single inner
 * (wrapped) kscan device (`kscan` phandle, required -- see
 * app/src/kscan_sideband_behaviors.c).
 * ===========================================================================
 */
#if DT_HAS_COMPAT_STATUS_OKAY(zmk_kscan_sideband_behaviors)

struct ksd_sideband_wrapper {
    const struct device *wrapper;
    const struct device *inner;
};

#define KSD_SIDEBAND_ENTRY(n)                                                                      \
    {                                                                                              \
        .wrapper = DEVICE_DT_GET(n),                                                               \
        .inner = DEVICE_DT_GET(DT_PHANDLE(n, kscan)),                                              \
    },

static const struct ksd_sideband_wrapper ksd_sideband_wrappers[] = {
    DT_FOREACH_STATUS_OKAY(zmk_kscan_sideband_behaviors, KSD_SIDEBAND_ENTRY)};
#define KSD_SIDEBAND_WRAPPER_COUNT DT_NUM_INST_STATUS_OKAY(zmk_kscan_sideband_behaviors)

#else
#define KSD_SIDEBAND_WRAPPER_COUNT 0
#endif

/**
 * Resolve a device pointer (possibly a composite or sideband-behaviors
 * wrapper) down to a list of {leaf_index, row_offset, col_offset} triples,
 * appended into @p out (capacity @p out_cap). Returns the number of entries
 * written (may be 0 if the device is unknown).
 */
static size_t ksd_topology_resolve(const struct device *dev, struct ksd_layout_device *out,
                                   size_t out_cap) {
    if (dev == NULL) {
        return 0;
    }

#if KSD_SIDEBAND_WRAPPER_COUNT > 0
    for (size_t i = 0; i < KSD_SIDEBAND_WRAPPER_COUNT; i++) {
        if (ksd_sideband_wrappers[i].wrapper == dev) {
            return ksd_topology_resolve(ksd_sideband_wrappers[i].inner, out, out_cap);
        }
    }
#endif

#if KSD_COMPOSITE_WRAPPER_COUNT > 0
    for (size_t i = 0; i < KSD_COMPOSITE_WRAPPER_COUNT; i++) {
        if (ksd_composite_wrappers[i].wrapper == dev) {
            size_t written = 0;
            for (size_t c = 0; c < ksd_composite_wrappers[i].child_count && written < out_cap;
                 c++) {
                const struct ksd_composite_child *child = &ksd_composite_wrappers[i].children[c];
                int32_t leaf_index = ksd_leaf_index_for_device(child->kscan);
                if (leaf_index < 0) {
                    /* Child itself may be a nested wrapper (e.g. sideband
                     * behaviors wrapping a leaf); resolve recursively. */
                    struct ksd_layout_device nested[KSD_COMPOSITE_NESTED_MAX];
                    size_t nested_count =
                        ksd_topology_resolve(child->kscan, nested, ARRAY_SIZE(nested));
                    for (size_t k = 0; k < nested_count && written < out_cap; k++) {
                        out[written] = nested[k];
                        out[written].row_offset += child->row_offset;
                        out[written].col_offset += child->col_offset;
                        written++;
                    }
                    continue;
                }
                out[written].leaf_index = (uint16_t)leaf_index;
                out[written].row_offset = child->row_offset;
                out[written].col_offset = child->col_offset;
                written++;
            }
            return written;
        }
    }
#endif

    int32_t leaf_index = ksd_leaf_index_for_device(dev);
    if (leaf_index < 0 || out_cap == 0) {
        return 0;
    }
    out[0].leaf_index = (uint16_t)leaf_index;
    out[0].row_offset = 0;
    out[0].col_offset = 0;
    return 1;
}

/*
 * ===========================================================================
 * Physical layouts: one entry per zmk,physical-layout DT node (or ZMK's
 * chosen-node synthesized layout -- see app/src/physical_layouts.c). We keep
 * our own rows/columns/kscan/map table plus the resolved leaf-device list.
 * Public map coordinates use the full transform grid; resolved local device
 * offsets include its origin once. The opaque core transform is not accessed.
 * ===========================================================================
 */
struct ksd_layout_dt_entry {
    const char *display_name;
    uint16_t rows;
    uint16_t columns;
    const struct device *kscan;
    const uint32_t *map;
    size_t map_count;
    uint16_t row_offset;
    uint16_t col_offset;
};

#define KSD_TRANSFORM_FIELDS(n)                                                                    \
    .rows = DT_PROP(n, rows), .columns = DT_PROP(n, columns),                                      \
    .map = (const uint32_t[])DT_PROP(n, map), .map_count = DT_PROP_LEN(n, map),                    \
    .row_offset = DT_PROP_OR(n, row_offset, 0), .col_offset = DT_PROP_OR(n, col_offset, 0)

#if DT_HAS_COMPAT_STATUS_OKAY(zmk_physical_layout) && !DT_HAS_CHOSEN(zmk_matrix_transform)

/* Mirrors physical_layouts.c: an explicit `kscan` phandle wins, otherwise the
 * `zmk,kscan` chosen node is used as a fallback (if present). */
#define KSD_LAYOUT_KSCAN_DEV(n)                                                                    \
    COND_CODE_1(                                                                                   \
        DT_NODE_HAS_PROP(n, kscan), (DEVICE_DT_GET(DT_PHANDLE(n, kscan))),                         \
        (COND_CODE_1(DT_HAS_CHOSEN(zmk_kscan), (DEVICE_DT_GET(DT_CHOSEN(zmk_kscan))), (NULL))))

#define KSD_LAYOUT_ENTRY(n)                                                                        \
    {                                                                                              \
        .display_name = DT_PROP(n, display_name),                                                  \
        KSD_TRANSFORM_FIELDS(DT_PHANDLE(n, transform)),                                            \
        .kscan = KSD_LAYOUT_KSCAN_DEV(n),                                                          \
    },

static const struct ksd_layout_dt_entry ksd_layout_dt_entries[] = {
    DT_FOREACH_STATUS_OKAY(zmk_physical_layout, KSD_LAYOUT_ENTRY)};
#define KSD_LAYOUT_DT_ENTRY_COUNT DT_NUM_INST_STATUS_OKAY(zmk_physical_layout)

#elif DT_HAS_CHOSEN(zmk_matrix_transform)
static const struct ksd_layout_dt_entry ksd_layout_dt_entries[] = {{
    .display_name = "Default",
    KSD_TRANSFORM_FIELDS(DT_CHOSEN(zmk_matrix_transform)),
#if DT_HAS_CHOSEN(zmk_kscan)
    .kscan = DEVICE_DT_GET(DT_CHOSEN(zmk_kscan)),
#endif
}};
#define KSD_LAYOUT_DT_ENTRY_COUNT 1
#elif DT_HAS_CHOSEN(zmk_kscan) && defined(ZMK_MATRIX_ROWS) && defined(ZMK_MATRIX_COLS)
static const struct ksd_layout_dt_entry ksd_layout_dt_entries[] = {{
    .display_name = "Default",
    .rows = ZMK_MATRIX_ROWS,
    .columns = ZMK_MATRIX_COLS,
    .kscan = DEVICE_DT_GET(DT_CHOSEN(zmk_kscan)),
}};
#define KSD_LAYOUT_DT_ENTRY_COUNT 1
#else
static const struct ksd_layout_dt_entry ksd_layout_dt_entries[1];
#define KSD_LAYOUT_DT_ENTRY_COUNT 0
#endif

/* Per-layout resolved device list, computed lazily (needs leaf devices). */
#define KSD_LAYOUT_MAX_DEVICES 4

#if KSD_LAYOUT_DT_ENTRY_COUNT > 0
static struct ksd_layout_device ksd_layout_devices[KSD_LAYOUT_DT_ENTRY_COUNT]
                                                  [KSD_LAYOUT_MAX_DEVICES];
static size_t ksd_layout_device_counts[KSD_LAYOUT_DT_ENTRY_COUNT];
static struct ksd_layout ksd_layouts[KSD_LAYOUT_DT_ENTRY_COUNT];
static bool ksd_layouts_ready;

static void ksd_layouts_init(void) {
    if (ksd_layouts_ready) {
        return;
    }
    ksd_leaf_devices_init();
    for (size_t i = 0; i < KSD_LAYOUT_DT_ENTRY_COUNT; i++) {
        const struct ksd_layout_dt_entry *e = &ksd_layout_dt_entries[i];
        ksd_layout_device_counts[i] =
            ksd_topology_resolve(e->kscan, ksd_layout_devices[i], KSD_LAYOUT_MAX_DEVICES);
        /* Wrapper offsets start in local scan coordinates. Publish them in
         * the full transform grid, applying its origin exactly once. */
        for (size_t d = 0; d < ksd_layout_device_counts[i]; d++) {
            ksd_layout_devices[i][d].row_offset += e->row_offset;
            ksd_layout_devices[i][d].col_offset += e->col_offset;
        }
        ksd_layouts[i].display_name = e->display_name;
        ksd_layouts[i].rows = e->rows;
        ksd_layouts[i].columns = e->columns;
        ksd_layouts[i].key_count = (uint16_t)(e->rows * e->columns);
        ksd_layouts[i].devices = ksd_layout_devices[i];
        ksd_layouts[i].device_count = ksd_layout_device_counts[i];
    }
    ksd_layouts_ready = true;
}
#else
static inline void ksd_layouts_init(void) {}
#endif

size_t ksd_topology_layout_count(void) { return KSD_LAYOUT_DT_ENTRY_COUNT; }

const struct ksd_layout *ksd_topology_get_layout(size_t index) {
    if (index >= KSD_LAYOUT_DT_ENTRY_COUNT) {
        return NULL;
    }
    ksd_layouts_init();
#if KSD_LAYOUT_DT_ENTRY_COUNT > 0
    return &ksd_layouts[index];
#else
    return NULL;
#endif
}

size_t ksd_topology_selected_layout(void) {
    /* zmk_physical_layouts_get_selected() reports the runtime-selected index
     * into zmk_physical_layouts_get_list(), which enumerates the same
     * zmk,physical-layout DT nodes (or the single chosen-node synthesized
     * layout) in the same order as our own DT table below, so the index
     * spaces match 1:1. */
    int selected = zmk_physical_layouts_get_selected();
    return selected >= 0 ? (size_t)selected : 0;
}

int32_t ksd_topology_position_for_cell(size_t layout_index, uint32_t row, uint32_t column) {
    const struct ksd_layout *layout = ksd_topology_get_layout(layout_index);
    if (layout == NULL) {
        return -1;
    }
    if (row >= layout->rows || column >= layout->columns) {
        return -1;
    }
    const struct ksd_layout_dt_entry *entry = &ksd_layout_dt_entries[layout_index];
    if (entry->map == NULL) {
        return row * layout->columns + column;
    }
    /* GetPositionMap enumerates GLOBAL transform cells. The core conversion
     * API instead accepts LOCAL scan coordinates and adds row/column offsets.
     * Read the public DT map directly so cells on either half, including those
     * before the local origin, retain their original position and cannot alias
     * the next row. No opaque core transform fields are accessed. */
    for (size_t position = entry->map_count; position > 0; position--) {
        uint32_t cell = entry->map[position - 1];
        if ((cell >> 8) == row && (cell & 0xff) == column)
            return position - 1;
    }
    return -1;
}
