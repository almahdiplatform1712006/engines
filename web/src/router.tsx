// A few screens don't need a router library: the path is the state.
import { useEffect, useState } from "react";

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => {
      setPath(location.pathname);
    };
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

/** `/o/:orgId/:screen` → its parts. */
export function matchOrg(
  path: string,
): { orgId: string; screen: string } | null {
  const match = /^\/o\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (!match?.[1]) return null;
  return { orgId: safeDecode(match[1]), screen: match[2] ?? "keys" };
}

export function Link(props: {
  to: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={props.to}
      className={props.className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

/** A path segment, decoded; a malformed one is left as it is. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
