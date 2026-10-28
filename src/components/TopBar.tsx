"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher, postJson, prPath, relativeTime } from "@/lib/client";
import { Spinner } from "@/components/ui";
import type { AppNotification } from "@/lib/types";

interface Status {
  auth: { ok: boolean; message: string; login?: string };
  viewer: string;
  org: string;
  unread: number;
}

const KIND_LABEL: Record<AppNotification["kind"], { icon: string; label: string; color?: string }> = {
  new_pr: { icon: "✦", label: "New PR" },
  mention: { icon: "@", label: "Mention" },
  reply: { icon: "↩", label: "Reply" },
  review_request: { icon: "👁", label: "Review requested" },
  ci_failed: { icon: "✕", label: "CI failed", color: "var(--status-critical)" },
  approved: { icon: "✓", label: "Your PR approved", color: "var(--status-good)" },
  changes_requested: { icon: "±", label: "Changes requested", color: "var(--status-serious)" },
};

type BrowserPermission = NotificationPermission | "unsupported";

/** This browser's notification permission, kept live if it changes elsewhere. */
export function useNotificationPermission(): [BrowserPermission, () => Promise<void>] {
  const [permission, setPermission] = useState<BrowserPermission>("default");

  useEffect(() => {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
    let status: PermissionStatus | null = null;
    const sync = () => setPermission(Notification.permission);
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((s) => {
        status = s;
        s.addEventListener("change", sync);
      })
      .catch(() => undefined);
    return () => status?.removeEventListener("change", sync);
  }, []);

  const request = async () => {
    if (!("Notification" in window)) return;
    setPermission(await Notification.requestPermission());
  };
  return [permission, request];
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [permission] = useNotificationPermission();
  const browserAlerts = permission === "granted";

  // A permitted tab takes over desktop alerts from the server, so it has to
  // keep polling while hidden — that's exactly when an alert matters.
  const { data, mutate } = useSWR<{
    notifications: AppNotification[];
    unread: number;
    lastPoll: number;
    alerts: AppNotification[];
  }>(browserAlerts ? "/api/notifications?browser=1" : "/api/notifications", fetcher, {
    refreshInterval: browserAlerts ? 30_000 : 60_000,
    refreshWhenHidden: browserAlerts,
  });

  const shown = useRef(new Set<string>());
  useEffect(() => {
    for (const alert of data?.alerts ?? []) {
      if (shown.current.has(alert.id)) continue;
      shown.current.add(alert.id);

      const notification = new Notification(alert.title, {
        body: `${KIND_LABEL[alert.kind]?.label ?? "Update"} · ${alert.body}`,
        tag: alert.id,
      });
      notification.onclick = () => {
        window.focus();
        if (alert.owner && alert.repo && alert.number) {
          router.push(prPath(alert.owner, alert.repo, alert.number));
        } else {
          window.open(alert.url, "_blank", "noopener");
        }
        notification.close();
        void postJson("/api/notifications", { action: "markRead", ids: [alert.id] }).then(() => mutate());
      };
    }
  }, [data, router, mutate]);

  const [busy, setBusy] = useState<"poll" | "read" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // A result message is the only way to tell "checked, nothing new" apart from
  // "the button is broken".
  const announce = (text: string) => {
    setStatus(text);
    setTimeout(() => setStatus(null), 4000);
  };

  const checkNow = async () => {
    setBusy("poll");
    setStatus(null);
    try {
      const result = await postJson<{ created: number }>("/api/notifications", { action: "poll" });
      await mutate();
      announce(result.created > 0 ? `${result.created} new` : "Nothing new");
    } catch (err) {
      announce(err instanceof Error ? err.message : "Check failed");
    } finally {
      setBusy(null);
    }
  };

  const markAllRead = async () => {
    setBusy("read");
    try {
      const result = await postJson<{ marked: number }>("/api/notifications", { action: "markRead" });
      await mutate();
      announce(result.marked > 0 ? `Marked ${result.marked} as read` : "Already all read");
    } catch (err) {
      announce(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const unread = data?.unread ?? 0;
  const items = data?.notifications ?? [];

  return (
    <div ref={panelRef} style={{ position: "relative" }}>
      <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)} aria-label="Notifications">
        <span aria-hidden>🔔</span>
        {unread > 0 ? (
          <span
            className="tabular"
            style={{
              background: "var(--status-critical)",
              color: "#fff",
              borderRadius: 999,
              padding: "0 6px",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 420,
            maxHeight: 520,
            overflowY: "auto",
            zIndex: 50,
            boxShadow: "0 12px 36px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "11px 14px",
              borderBottom: "1px solid var(--border)",
              position: "sticky",
              top: 0,
              background: "var(--surface-1)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontSize: 13 }}>Notifications</strong>
              <div className="muted" style={{ fontSize: 11 }}>
                {status ? (
                  <span style={{ color: "var(--series-1)" }}>{status}</span>
                ) : data?.lastPoll ? (
                  `checked ${relativeTime(data.lastPoll)}`
                ) : (
                  "not checked yet"
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, flex: "none" }}>
              <button type="button" className="btn btn-sm" onClick={checkNow} disabled={busy !== null}>
                {busy === "poll" ? <Spinner /> : null}
                {busy === "poll" ? "Checking…" : "Check now"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={markAllRead}
                disabled={busy !== null || unread === 0}
                title={unread === 0 ? "Nothing unread" : `Mark ${unread} as read`}
              >
                {busy === "read" ? <Spinner /> : null}
                Mark all read
              </button>
            </div>
          </div>

          {items.length === 0 ? (
            <div className="muted" style={{ padding: 22, textAlign: "center", fontSize: 13 }}>
              Nothing yet. New PRs matching your filters, mentions and replies land here.
            </div>
          ) : (
            items.map((item) => {
              const meta = KIND_LABEL[item.kind];
              return (
                <button
                  type="button"
                  key={item.id}
                  onClick={async () => {
                    await postJson("/api/notifications", { action: "markRead", ids: [item.id] });
                    void mutate();
                    setOpen(false);
                    if (item.owner && item.repo && item.number) {
                      router.push(prPath(item.owner, item.repo, item.number));
                    } else {
                      window.open(item.url, "_blank", "noreferrer");
                    }
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "11px 14px",
                    borderBottom: "1px solid var(--border)",
                    background:
                      item.readAt || item.resolved
                        ? "transparent"
                        : "color-mix(in srgb, var(--series-1) 9%, transparent)",
                    border: "none",
                    borderBottomWidth: 1,
                    borderBottomStyle: "solid",
                    cursor: "pointer",
                    color: "inherit",
                    fontFamily: "inherit",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                    <span
                      className="chip"
                      style={{ fontSize: 10.5, color: meta.color, borderColor: meta.color }}
                    >
                      <span aria-hidden>{meta.icon}</span>
                      {meta.label}
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {relativeTime(item.createdAt)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      lineHeight: 1.4,
                      textDecoration: item.resolved ? "line-through" : undefined,
                      opacity: item.resolved ? 0.6 : 1,
                    }}
                  >
                    {item.title}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {item.body}
                  </div>
                  {item.via ? (
                    <div style={{ fontSize: 11, color: "var(--series-1)", marginTop: 2 }}>{item.via}</div>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function PrJump() {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const go = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const target = await postJson<{ owner: string; repo: string; number: number }>(
        "/api/prs/resolve",
        { input: value },
      );
      setValue("");
      router.push(prPath(target.owner, target.repo, target.number));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 440 }}>
      <input
        className="input"
        placeholder="Paste a PR link, or owner/repo#123 — press Enter"
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void go();
        }}
      />
      {error ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 5px)",
            left: 0,
            right: 0,
            padding: "7px 11px",
            borderRadius: 7,
            background: "var(--surface-2)",
            border: "1px solid var(--status-critical)",
            color: "var(--status-critical)",
            fontSize: 12,
            zIndex: 20,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const { data: status } = useSWR<Status>("/api/status", fetcher, { refreshInterval: 120_000 });

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        background: "color-mix(in srgb, var(--surface-0) 88%, transparent)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "11px 24px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 650, fontSize: 15 }}>
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: "var(--series-1)",
              display: "grid",
              placeItems: "center",
              color: "#fff",
              fontSize: 13,
            }}
            aria-hidden
          >
            ⌘
          </span>
          PR Reviewer
        </Link>

        <PrJump />

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
          {status && !status.auth.ok ? (
            <span className="chip" style={{ color: "var(--status-critical)", borderColor: "var(--status-critical)" }}>
              <span aria-hidden>✕</span> gh not authenticated
            </span>
          ) : status?.viewer ? (
            <span className="chip">
              <span aria-hidden>●</span> {status.viewer}
            </span>
          ) : null}

          <NotificationBell />

          <Link
            href="/settings"
            className="btn btn-sm"
            style={{
              borderColor: pathname === "/settings" ? "var(--series-1)" : undefined,
            }}
          >
            Settings
          </Link>
        </div>
      </div>
    </header>
  );
}
