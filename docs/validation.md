# Validation and acceptance scope

This is a reproducible validation guide for the maintenance fork. Individual
device identities, local execution histories and private measurements are not
part of this document. It does not assert a new physical-hardware result.

## Software checks

Prepare the dependencies selected by `west/west-test-workspace.yml` explicitly
inside Docker. Record the image digest, resolved project commits and enabled
configuration. Keep workspaces, build outputs and caches in container images
or named volumes; ordinary tests must not fetch or update dependencies.

From this checkout in that prepared environment, use the owner's entries:

```sh
python3 -m unittest -v
west zmk-test tests -m .
west zmk-build tests/zmk-config
```

The Python entry validates both native scenarios and the build matrix. Direct
west entries are useful for diagnosis and do not replace its result assertions.
Keep all variants and snapshots; never accept a changed snapshot to clear a
failure. Web checks use the lockfile and the entries in `web/README.md`.

The native fixtures use scripted kscan events. The `tester_xiao` build profiles
select direct, matrix, composite and charlieplex/demux topology scenarios.
The `diag-hw-mock` snippet supplies a synthetic scan and physical layout for a
separate integration check. These fixtures validate software/topology behavior,
not switch wiring, electrical continuity, debounce quality or radio delivery.

## Hardware acceptance procedure

Use a separately authorized integrating-keyboard build and retain its complete
source/configuration and firmware identity privately. Confirm the selected
transport, matching client protocol and physical Studio unlock before querying
the secured diagnostics subsystem.

Verify `GetInfo`, `GetLayout`, `GetDevice`, `GetGpioPins`, `GetPositionMap` and
`GetStats` against the integrating keyboard's declared topology. Check every
position, row/column mapping, press/release behavior and reset-statistics result
with controlled inputs. Identify scripted mock input separately from actual
switch input. Split diagnostics require their documented relay configuration
on both halves; a central-only result does not establish peripheral acceptance.

USB/BLE delivery, split transport, physical timing, wiring faults, reset and
power need matching device observations. A successful build or RPC read cannot
supply those results. Keep raw captures and device matching details private;
share only a separately reviewed, explicitly scoped summary when authorized.
