/**
 * Own the optional input-stream subscription for one connection/subsystem.
 * Coverage keeps using statistics until EnableStream has actually succeeded.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MetaError } from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import type { CustomNotification } from "@zmkfirmware/zmk-studio-ts-client/custom";
import {
  ZMKAppContext,
  ZMKCustomSubsystem,
} from "@cormoran/zmk-studio-react-hook";
import {
  Notification,
  Request,
  Response,
} from "./proto/zmk/input_stream/input_stream";

export const INPUT_STREAM_SUBSYSTEM_IDENTIFIER = "zmk__input_stream";

export interface KeyEvent {
  position: number;
  pressed: boolean;
  behaviorId: number;
  param1: number;
  param2: number;
  /** Browser receive time for visualization, never firmware timing evidence. */
  receivedAt: number;
}

const MAX_EVENT_LOG = 500;

interface Session {
  service: ZMKCustomSubsystem | null;
  active: boolean;
  request: number;
  wantsStream: boolean;
  accepting: boolean;
  locked: boolean;
  lease: { epoch: number; leaseMs: number } | null;
}

interface StreamState {
  owner: ZMKCustomSubsystem | null;
  locked: boolean;
  enabled: boolean;
  isLoading: boolean;
  error: string | null;
  events: KeyEvent[];
  pressedPositions: Set<number>;
  activeLayer: number;
}

function initialState(owner: ZMKCustomSubsystem | null): StreamState {
  return {
    owner,
    locked: false,
    enabled: false,
    isLoading: false,
    error: null,
    events: [],
    pressedPositions: new Set(),
    activeLayer: 0,
  };
}

export interface UseInputStreamReturn {
  available: boolean;
  locked: boolean;
  enabled: boolean;
  isLoading: boolean;
  error: string | null;
  /** Newest first; retained events keep their object identity across updates. */
  events: KeyEvent[];
  /** Current held keys, independent of the bounded event history. */
  pressedPositions: Set<number>;
  activeLayer: number;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  clearEvents: () => void;
}

export function useInputStream(): UseInputStreamReturn {
  const zmkApp = useContext(ZMKAppContext);
  const connection = zmkApp?.state.connection ?? null;
  const subsystemIndex = zmkApp?.findSubsystem(
    INPUT_STREAM_SUBSYSTEM_IDENTIFIER
  )?.index;
  const service = useMemo(
    () =>
      connection && subsystemIndex !== undefined
        ? new ZMKCustomSubsystem(connection, subsystemIndex)
        : null,
    [connection, subsystemIndex]
  );
  const lifetime = useRef<Session>({
    service,
    active: true,
    request: 0,
    wantsStream: false,
    accepting: false,
    locked: false,
    lease: null,
  });
  const [stored, setStored] = useState(() => initialState(service));
  const state = stored.owner === service ? stored : initialState(service);
  const update = useCallback(
    (change: (current: StreamState) => StreamState) => {
      setStored((previous) => {
        const session = lifetime.current;
        if (!session.active || session.service !== service) return previous;
        return change(
          previous.owner === service ? previous : initialState(service)
        );
      });
    },
    [service]
  );

  const setStreaming = useCallback(
    async (enable: boolean) => {
      const session = lifetime.current;
      if (
        !session.active ||
        !service ||
        session.service !== service ||
        (enable && session.locked)
      )
        return;
      const ticket = ++session.request;
      session.lease = null;
      const owns = () =>
        session.active &&
        session.service === service &&
        session.request === ticket;
      session.accepting = enable;
      if (enable) session.wantsStream = true;
      update((s) => ({
        ...s,
        enabled: false,
        isLoading: true,
        locked: false,
        error: null,
        pressedPositions: new Set(),
      }));
      try {
        const request = Request.create(
          enable ? { enableStream: {} } : { disableStream: {} }
        );
        const payload = await service.callRPC(Request.encode(request).finish());
        if (!owns()) return;
        if (!payload) throw new Error("Empty input-stream response");
        const response = Response.decode(payload);
        if (response.error)
          throw new Error(response.error.message || "Input stream failed");
        if (!response.ok)
          throw new Error("Missing input-stream acknowledgement");
        if (enable && response.ok.leaseMs && !response.ok.streamEpoch)
          throw new Error("Input-stream lease expired before acknowledgement");
        if (enable && response.ok.streamEpoch && response.ok.leaseMs)
          session.lease = {
            epoch: response.ok.streamEpoch,
            leaseMs: response.ok.leaseMs,
          };
        if (!enable) session.wantsStream = false;
        update((s) => ({ ...s, enabled: enable, isLoading: false }));
      } catch (error) {
        if (!owns()) return;
        session.accepting = false;
        const locked =
          error instanceof MetaError &&
          error.condition === ErrorConditions.UNLOCK_REQUIRED;
        update((s) => ({
          ...s,
          enabled: false,
          isLoading: false,
          locked,
          error: locked
            ? null
            : error instanceof Error
              ? error.message
              : "Input stream failed",
          pressedPositions: new Set(),
        }));
      }
    },
    [service, update]
  );
  const enable = useCallback(() => setStreaming(true), [setStreaming]);
  const disable = useCallback(() => setStreaming(false), [setStreaming]);

  useEffect(() => {
    if (!zmkApp || !service) return;
    let active = true;
    const unsubscribe = zmkApp.onNotification({
      type: "core",
      callback: (notification) => {
        const session = lifetime.current;
        if (
          !active ||
          !session.active ||
          session.service !== service ||
          notification.lockStateChanged === undefined
        )
          return;
        session.locked =
          notification.lockStateChanged !==
          LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
        if (!session.locked) {
          update((s) => ({ ...s, locked: false }));
          return;
        }
        session.request++;
        session.accepting = false;
        session.wantsStream = false;
        session.lease = null;
        update((s) => ({
          ...s,
          locked: true,
          enabled: false,
          isLoading: false,
          error: null,
          events: [],
          pressedPositions: new Set(),
          activeLayer: 0,
        }));
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [zmkApp, service, update]);

  useEffect(() => {
    const session = lifetime.current;
    const lease = session.lease;
    if (!state.enabled || !service || !lease) return;
    const ticket = session.request;
    let retired = false;
    let pending = false;
    const owns = () =>
      !retired &&
      session.active &&
      session.service === service &&
      session.request === ticket &&
      session.lease === lease &&
      !session.locked;
    const timer = window.setInterval(() => {
      if (!owns() || pending) return;
      pending = true;
      const request = Request.create({
        enableStream: { renewOnly: true, streamEpoch: lease.epoch },
      });
      void service
        .callRPC(Request.encode(request).finish())
        .then((bytes) => {
          if (!owns()) return;
          if (!bytes) throw new Error("Missing input-stream renewal response");
          const response = Response.decode(bytes);
          if (response.error) throw new Error(response.error.message);
          if (response.ok?.streamEpoch !== lease.epoch)
            throw new Error("Input-stream lease expired or changed");
        })
        .catch((error: unknown) => {
          if (!owns()) return;
          session.request++;
          session.lease = null;
          session.accepting = false;
          session.wantsStream = false;
          update((s) => ({
            ...s,
            enabled: false,
            isLoading: false,
            error:
              error instanceof Error
                ? error.message
                : "Input stream renewal failed",
            pressedPositions: new Set(),
          }));
        })
        .finally(() => {
          pending = false;
        });
    }, 2000);
    return () => {
      retired = true;
      window.clearInterval(timer);
    };
  }, [state.enabled, service, update]);

  useEffect(() => {
    if (!zmkApp || subsystemIndex === undefined) return;
    let active = true;
    const unsubscribe = zmkApp.onNotification({
      type: "custom",
      subsystemIndex,
      callback: (notification: CustomNotification) => {
        const session = lifetime.current;
        if (
          !active ||
          !session.active ||
          !session.accepting ||
          session.service !== service
        )
          return;
        try {
          const decoded = Notification.decode(notification.payload);
          if (decoded.keyEvent) {
            const event = {
              ...decoded.keyEvent,
              receivedAt: performance.now(),
            };
            update((s) => {
              const held = new Set(s.pressedPositions);
              if (event.pressed) held.add(event.position);
              else held.delete(event.position);
              return {
                ...s,
                events: [event, ...s.events].slice(0, MAX_EVENT_LOG),
                pressedPositions: held,
              };
            });
          }
          if (decoded.layerChange) {
            const layer = decoded.layerChange.layerIndex;
            update((s) => ({ ...s, activeLayer: layer }));
          }
        } catch {
          // A malformed notification must not retire the working subscription.
        }
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [zmkApp, subsystemIndex, service, update]);

  useEffect(() => {
    const session = lifetime.current;
    session.service = service;
    session.active = true;
    session.wantsStream = false;
    session.accepting = false;
    session.locked = false;
    session.lease = null;
    const stop = () => {
      if (session.service !== service) return;
      session.accepting = false;
      session.lease = null;
      if (!session.wantsStream || !service) return;
      session.wantsStream = false;
      const payload = Request.encode(
        Request.create({ disableStream: {} })
      ).finish();
      // Capture this session's service, including while EnableStream is pending.
      void service.callRPC(payload).catch(() => {});
    };
    const beforeUnload = () => {
      session.request++;
      stop();
      update((s) => ({
        ...s,
        enabled: false,
        isLoading: false,
        pressedPositions: new Set(),
      }));
    };
    window.addEventListener("beforeunload", beforeUnload);
    void enable();
    return () => {
      if (session.service === service) {
        session.active = false;
        session.request++;
      }
      window.removeEventListener("beforeunload", beforeUnload);
      stop();
    };
  }, [service, enable, update]);

  const clearEvents = useCallback(
    () => update((s) => ({ ...s, events: [] })),
    [update]
  );

  return {
    ...state,
    available: service !== null,
    enable,
    disable,
    clearEvents,
  };
}
