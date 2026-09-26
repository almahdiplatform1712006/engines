// Uploads straight to storage (Google Cloud Storage's resumable protocol, or
// the local imitation): the file goes up in chunks, a dropped connection
// resumes from what the server has, and a reload picks the same upload up
// again (spec §3 `POST /v1/uploads`, E-17).
import { api } from "./api.ts";

/** GCS takes chunks in multiples of 256 KiB. */
const CHUNK = 32 * 256 * 1024;
const RETRIES = 8;
const STORAGE_KEY = "engines.uploads";

export interface UploadProgress {
  sent: number;
  total: number;
}

interface Session {
  id: string;
  url: string;
  expires_at: string;
}

/** Where a file's unfinished upload is, so a reload resumes it. */
function sessions(): Record<string, Session> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
      string,
      Session
    >;
  } catch {
    return {};
  }
}

function remember(file: File, orgId: string, session: Session | null): void {
  try {
    const key = fileKey(file, orgId);
    const others = Object.entries(sessions()).filter(([k]) => k !== key);
    const all = Object.fromEntries(
      session ? [...others, [key, session]] : others,
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Without storage, a reload starts the upload over.
  }
}

/** Uploads belong to an organisation: the same file in another one is a new upload. */
function fileKey(file: File, orgId: string): string {
  return `${orgId}|${file.name}|${String(file.size)}|${String(file.lastModified)}`;
}

/** Uploads the file and returns its upload id. */
export async function uploadFile(
  file: File,
  orgId: string,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const total = file.size;
  let session = sessions()[fileKey(file, orgId)];
  if (!session || new Date(session.expires_at) <= new Date()) {
    const created = await api<{
      id: string;
      upload_url: string;
      expires_at: string;
    }>("POST", "/v1/uploads", {
      orgId,
      body: {
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        size: total,
      },
    });
    session = {
      id: created.id,
      url: created.upload_url,
      expires_at: created.expires_at,
    };
    remember(file, orgId, session);
  }

  const { url } = session;
  let sent: number;
  try {
    sent = await received(url, total, signal);
  } catch (error) {
    // The upload is gone (expired, or never finished creating): start over next time.
    remember(file, orgId, null);
    throw error;
  }
  onProgress({ sent, total });
  let failures = 0;
  while (sent < total) {
    const end = Math.min(sent + CHUNK, total);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "content-range": `bytes ${String(sent)}-${String(end - 1)}/${String(total)}`,
        },
        body: file.slice(sent, end),
        ...(signal ? { signal } : {}),
      });
      if (response.ok) sent = total;
      else if (response.status === 308) {
        const now = rangeEnd(response);
        // Storage must say how much it has; without it the chunk would be sent forever.
        if (now <= sent) throw new Error("the upload isn't moving forward");
        sent = now;
      } else throw new Error(`upload refused (${String(response.status)})`);
      failures = 0;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (++failures > RETRIES) throw error;
      // Wait, then ask the server how much it really has.
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** failures));
      sent = await received(url, total, signal).catch(() => sent);
    }
    onProgress({ sent, total });
  }
  remember(file, orgId, null);
  return session.id;
}

/** How many bytes the server has, from a status query. */
async function received(
  url: string,
  total: number,
  signal?: AbortSignal,
): Promise<number> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-range": `bytes */${String(total)}` },
    ...(signal ? { signal } : {}),
  });
  if (response.ok) return total;
  if (response.status === 308) return rangeEnd(response);
  throw new Error(`upload not found (${String(response.status)})`);
}

/** `Range: bytes=0-N` → N + 1; no Range header means nothing has arrived. */
function rangeEnd(response: Response): number {
  const match = /bytes=0-(\d+)/.exec(response.headers.get("range") ?? "");
  return match?.[1] ? Number(match[1]) + 1 : 0;
}
