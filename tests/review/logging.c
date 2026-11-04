/* SPDX-License-Identifier: MIT */
#include <zephyr/logging/log.h>

/* The included production relay owns its declaration in main.c. */
LOG_MODULE_REGISTER(zmk, CONFIG_ZMK_LOG_LEVEL);
