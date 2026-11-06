/** The shell: which wallet state we're in, the tabs and rail, the note that this is test money, and the routes. */
import { useEffect, useState, type ReactNode } from "react";
import { engine, isFake } from "./wallet";
import { Verify } from "./screens/verify";
import { go, LiveProvider, note, TaskProvider, useLive, useRoute } from "./ui";
import { Backup, Brand, Create, Lock, ReceiveKey, Recover, Recovering, Restore, Welcome } from "./screens/onboarding";
import { Home, Queue, statusOf } from "./screens/home";
import { Drill, Escape, Move, Paper, Protection, rows } from "./screens/protection";
import { Activity, Pool, Receive, Safe, Send } from "./screens/money";
import { Forget, Settings } from "./screens/settings";

const icons: Record<string, ReactNode> = {
  home: <path d="M3 9.500 10 4l7 5.500V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.500Z" />,
  protection: <path d="M10 2.500 16.500 5v5c0 3.800-2.700 6.300-6.500 7.500C6.200 16.300 3.500 13.800 3.500 10V5L10 2.500Z" />,
  activity: <path d="M3 5h14M3 10h14M3 15h9" />,
  settings: <path d="M3 6h8m4 0h2M3 14h2m4 0h8M13 4v4M7 12v4" />,
  send: <path d="M10 16V4m-5 5 5-5 5 5" />,
  receive: <path d="M10 4v12m-5-5 5 5 5-5" />,
  pool: <path d="M3 10c2-2 3-2 5 0s3 2 5 0 3-2 4-1M3 14c2-2 3-2 5 0s3 2 5 0 3-2 4-1M3 6c2-2 3-2 5 0s3 2 5 0 3-2 4-1" />,
};
const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {icons[name]}
  </svg>
);

const TABS = [
  { path: "/", label: "Home", icon: "home" },
  { path: "/protection", label: "Protection", icon: "protection" },
  { path: "/activity", label: "Activity", icon: "activity" },
  { path: "/settings", label: "Settings", icon: "settings" },
];
const RAIL_EXTRA = [
  { path: "/send", label: "Send", icon: "send" },
  { path: "/receive", label: "Receive", icon: "receive" },
  { path: "/pool", label: "Private pool", icon: "pool" },
];

function Note() {
  return <p className={`devnet ${isFake ? "devnet-fake" : ""}`}>{isFake ? "Preview on a fake engine. Nothing here is real or on a chain." : "Test money on a public devnet."}</p>;
}

function Offline() {
  const { error, snap } = useLive();
  if (!error || !snap) return null;
  return (
    <p className="offline" role="status">
      Can't reach the chain. These are the last known values.
    </p>
  );
}

function Tabs({ route }: { route: string }) {
  const { snap } = useLive();
  const base = `/${route.split(/[/?]/)[1] ?? ""}`;
  const left = snap ? rows(snap).filter((r) => !r.done).length : 0;
  const isOn = (p: string) => (p === "/" ? base === "/" || base === "/queue" : base === p);
  return (
    <>
      <nav className="tabs" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.path} href={`#${t.path}`} className={isOn(t.path) ? "on" : ""} aria-current={isOn(t.path) ? "page" : undefined}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </a>
        ))}
      </nav>
      <nav className="rail" aria-label="Main">
        <Brand />
        <div className="rail-group">
          {TABS.slice(0, 2).map((t) => (
            <a key={t.path} href={`#${t.path}`} className={isOn(t.path) ? "on" : ""}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
              {t.path === "/protection" && left > 0 && <em>{left} to do</em>}
            </a>
          ))}
        </div>
        <div className="rail-group">
          {RAIL_EXTRA.map((t) => (
            <a key={t.path} href={`#${t.path}`} className={isOn(t.path) ? "on" : ""}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </a>
          ))}
        </div>
        <div className="rail-group">
          {TABS.slice(2).map((t) => (
            <a key={t.path} href={`#${t.path}`} className={isOn(t.path) ? "on" : ""}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </a>
          ))}
        </div>
        {snap && <p className={`status rail-status tone-${statusOf(snap).tone}`}><i />{statusOf(snap).word}</p>}
      </nav>
    </>
  );
}

function OpenApp({ route, onLock, onForget }: { route: string; onLock: () => void; onForget: () => void }) {
  const { snap, refresh } = useLive();
  const [, force] = useState(0);
  const path = route.split("?")[0] ?? "/";
  const query = new URLSearchParams(route.split("?")[1] ?? "");
  // Not skippable: until the file is saved and ticked, every route lands here.
  const mustBackUp = note.get("backupPending") === "1" || (snap !== null && !snap.backedUp);
  if (mustBackUp)
    return (
      <div className="plain-shell">
        <Note />
        <main>
          <Backup
            onDone={() => {
              // The last read may predate the download, and would hold this gate shut until the next poll.
              void refresh().then(() => {
                force((n) => n + 1);
                go("/");
              });
            }}
          />
        </main>
      </div>
    );

  // Flows that must hold attention hide the tabs.
  const focused = ["/drill", "/paper", "/move", "/escape", "/recovering", "/forget"].includes(path);
  let screen: ReactNode;
  switch (path) {
    case "/protection":
      screen = <Protection />;
      break;
    case "/drill":
      screen = <Drill />;
      break;
    case "/paper":
      screen = <Paper />;
      break;
    case "/move":
      screen = <Move />;
      break;
    case "/escape":
      screen = <Escape />;
      break;
    case "/send":
      screen = <Send code={query.get("code") ?? undefined} />;
      break;
    case "/receive":
      screen = <Receive />;
      break;
    case "/pool":
      screen = <Pool />;
      break;
    case "/safe":
      screen = <Safe />;
      break;
    case "/activity":
      screen = <Activity />;
      break;
    case "/settings":
      screen = <Settings onLock={onLock} />;
      break;
    case "/forget":
      screen = <Forget onForget={onForget} />;
      break;
    case "/queue":
      screen = <Queue />;
      break;
    case "/recovering":
      screen = <Recovering />;
      break;
    default:
      screen = <Home />;
  }
  return (
    <div className={`shell ${focused ? "focused" : ""}`}>
      <Note />
      <Offline />
      <main key={path}>{screen}</main>
      <Tabs route={route} />
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [state, setState] = useState(() => engine.state());
  const sync = () => setState(engine.state());
  const path = route.split("?")[0] ?? "/";

  // Coming back to the app picks up a lock that happened meanwhile. These three open a session partway through, and finish on their own screens.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === "visible" && !/^#\/(create|recover|restore)\b/.test(location.hash)) sync();
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  let body: ReactNode;
  if (path.startsWith("/link/")) {
    body = (
      <div className="plain-shell">
        <Note />
        <main>
          <ReceiveKey link={location.href} onReceived={sync} />
        </main>
      </div>
    );
  } else if (path === "/verify") {
    body = (
      <div className="plain-shell">
        <Note />
        <main>
          <Verify />
        </main>
      </div>
    );
  } else if (state === "open") {
    body = <OpenApp route={route} onLock={() => (engine.lock(), sync(), go("/"))} onForget={sync} />;
  } else {
    let page: ReactNode;
    if (path === "/restore") page = <Restore onDone={() => (sync(), go("/"))} onCleared={sync} />;
    else if (path === "/recover") page = <Recover onDone={() => (sync(), go("/"))} onCleared={sync} />;
    else if (state === "locked") page = <Lock onOpen={sync} />;
    else if (path === "/create") page = <Create onMade={() => (sync(), go("/"))} />;
    else page = <Welcome />;
    body = (
      <div className="plain-shell">
        <Note />
        <main key={state === "locked" && path !== "/restore" && path !== "/recover" ? "lock" : path}>{page}</main>
      </div>
    );
  }
  return (
    <LiveProvider active={state === "open"}>
      <TaskProvider>{body}</TaskProvider>
    </LiveProvider>
  );
}

