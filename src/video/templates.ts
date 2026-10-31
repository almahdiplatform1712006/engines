// A scene as one HyperFrames composition: plain HTML, right-to-left, with a
// tiny seek-driven timeline in place of GSAP (every frame is a pure function
// of the time, no network, no animation library). Pure: assets are named, the
// caller copies them next to the page.
import { escapeHtml, inline, toMathML } from "../shared/rich-text.ts";
import type { Scene } from "./schema.ts";

/** Bump when a template changes, so cached clips are rendered again. */
export const TEMPLATE_VERSION = 1;

export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Font files (from @fontsource/noto-sans-arabic, OFL) the page needs beside it. */
export const FONT_FILES = [
  "arabic-400-normal",
  "arabic-700-normal",
  "latin-400-normal",
  "latin-700-normal",
] as const;

export interface SceneTiming {
  /** Length of the scene in seconds: the take plus a short rest. */
  duration: number;
  /** When each revealed item appears, in order. */
  reveals: number[];
  /** The narration file next to the page. */
  audio: string;
  /** The figure's image file next to the page, for a figure scene. */
  figureFile?: string;
}

const CSS = `
${FONT_FILES.map(
  (f) =>
    `@font-face{font-family:"Almahdi Sans";src:url("fonts/${f}.woff2") format("woff2");font-weight:${f.endsWith("700-normal") ? "700" : "400"};unicode-range:${f.startsWith("arabic") ? "U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200F,U+2010-2011,U+204F,U+2E41" : "U+0000-00FF,U+2000-206F"};}`,
).join("\n")}
*{box-sizing:border-box}
html,body{margin:0}
#root{position:relative;width:${String(WIDTH)}px;height:${String(HEIGHT)}px;overflow:hidden;direction:rtl;
  background:linear-gradient(160deg,#0f1b3d 0%,#16295c 60%,#1d3a78 100%);color:#f4f7ff;
  font-family:"Almahdi Sans",sans-serif;font-size:52px;line-height:1.6}
.pane{position:absolute;inset:0;padding:96px 140px}
h1,h2{margin:0;font-weight:700}
h1{font-size:112px;line-height:1.3}
h2{font-size:76px;line-height:1.3;color:#ffd66b}
.sub{font-size:56px;color:#c9d6ff;margin-top:32px}
.rule{width:160px;height:8px;background:#ffd66b;border-radius:4px;margin:36px 0}
.item{opacity:0}
ul{list-style:none;margin:64px 0 0;padding:0}
li{display:flex;gap:36px;align-items:baseline;margin-bottom:34px}
.dot{flex:none;width:22px;height:22px;border-radius:50%;background:#ffd66b;transform:translateY(-6px)}
.row{display:flex;gap:48px;align-items:center;margin-bottom:36px;padding:20px 40px;background:rgba(255,255,255,.07);border-radius:24px}
.row .note{font-size:40px;color:#c9d6ff}
math{font-size:64px;font-family:"STIX Two Math","Latin Modern Math","DejaVu Sans",serif}
.fig{position:absolute;left:140px;top:240px;width:1000px;height:760px;background:#fff;border-radius:24px;display:flex;align-items:center;justify-content:center}
.fig img{max-width:94%;max-height:94%;object-fit:contain}
.callouts{position:absolute;right:140px;top:240px;width:560px}
.callout{padding:20px 32px;margin-bottom:28px;background:rgba(255,214,107,.16);border-right:10px solid #ffd66b;border-radius:16px;font-size:44px}
.center{display:flex;flex-direction:column;justify-content:center;height:100%}
`;

const RUNTIME = `
const els=[...document.querySelectorAll("[data-at]")];
const FADE=0.45;
function apply(t){for(const el of els){
  const p=Math.min(1,Math.max(0,(t-Number(el.dataset.at))/FADE)),e=p*(2-p);
  el.style.opacity=String(e);el.style.transform="translateY("+((1-e)*28)+"px)";}}
const tl={_t:0,paused:true,
  duration(){return DURATION},totalDuration(){return DURATION},
  time(t){if(t===undefined)return this._t;return this.seek(t)},
  seek(t){this._t=t;apply(t);return this},
  progress(){return this._t/DURATION},
  pause(){return this},play(){return this},getChildren(){return []},eventCallback(){return this}};
window.__timelines=window.__timelines||{};window.__timelines["root"]=tl;
apply(0);
`;

const item = (at: number, inner: string, tag = "div", cls = "") =>
  `<${tag} class="item ${cls}" data-at="${at.toFixed(3)}">${inner}</${tag}>`;

/** The slide's body, with each revealed item taking the next time in `reveals`. */
function body(scene: Scene, timing: SceneTiming): string {
  const reveals = timing.reveals;
  const at = (k: number) => reveals[k] ?? 0;
  switch (scene.type) {
    case "title":
      return `<div class="pane center">
${item(0.2, `<h1>${inline(scene.title, true)}</h1><div class="rule"></div>`)}
${scene.subtitle ? item(at(0), `<div class="sub">${inline(scene.subtitle, true)}</div>`) : ""}
</div>`;
    case "bullets":
      return `<div class="pane">
${item(0.1, `<h2>${inline(scene.title, true)}</h2>`)}
<ul>${scene.bullets
        .map((b, k) =>
          item(
            at(k),
            `<span class="dot"></span><span>${inline(b, true)}</span>`,
            "li",
          ),
        )
        .join("\n")}</ul>
</div>`;
    case "figure":
      return `<div class="pane">
${item(0.1, `<h2>${inline(scene.title, true)}</h2>`)}
${item(0.2, `<img src="${escapeHtml(timing.figureFile ?? "")}" alt="">`, "div", "fig")}
<div class="callouts">${scene.callouts
        .map((c, k) => item(at(k), inline(c, true), "div", "callout"))
        .join("\n")}</div>
</div>`;
    case "equation_steps":
      return `<div class="pane">
${item(0.1, `<h2>${inline(scene.title, true)}</h2>`)}
<div style="margin-top:56px">${scene.steps
        .map((s, k) =>
          item(
            at(k),
            `<span>${toMathML(s.latex, { display: false, rtl: scene.rtl })}</span>${
              s.note ? `<span class="note">${inline(s.note, true)}</span>` : ""
            }`,
            "div",
            "row",
          ),
        )
        .join("\n")}</div>
</div>`;
  }
}

/** How many items a scene reveals one by one, to ask the aligner for their times. */
export function revealCount(scene: Scene): number {
  switch (scene.type) {
    case "title":
      return scene.subtitle ? 1 : 0;
    case "bullets":
      return scene.bullets.length;
    case "figure":
      return scene.callouts.length;
    case "equation_steps":
      return scene.steps.length;
  }
}

export function scenePage(scene: Scene, timing: SceneTiming): string {
  const duration = timing.duration.toFixed(3);
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(scene.id)}</title>
<style>${CSS}</style></head><body>
<div id="root" data-composition-id="root" data-start="0" data-duration="${duration}" data-width="${String(WIDTH)}" data-height="${String(HEIGHT)}">
${body(scene, timing)}
<audio id="narration" src="${escapeHtml(timing.audio)}" data-start="0" data-duration="${duration}" data-track-index="1" data-volume="1"></audio>
<script>const DURATION=${duration};${RUNTIME}</script>
</div></body></html>`;
}
