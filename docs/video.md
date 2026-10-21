# Explainer videos

A lesson script in, an MP4 out. Egyptian Arabic narration over slides.

## Render a script

```sh
npm run video -- lesson.json --dry --out lesson.mp4   # silent voice, no model call
npm run video -- lesson.json --out lesson.mp4         # real voice
```

The real voice needs `OPENROUTER_API_KEY` and `TTS_MODEL` (and optionally `TTS_VOICE`, `TTS_STYLE`) in `.env`. It needs Chromium (`CHROMIUM_PATH` if it isn't on the usual paths) and FFmpeg. Figure images are files next to the script.

Rendering one scene takes about 15 s on 2 CPUs; a scene that has not changed is reused from `--work` (`.data/video`).

## A script

```json
{
  "schema_version": 1,
  "title": "حل المعادلات",
  "scenes": [
    { "id": "intro", "type": "title", "title": "…", "narration": "…" },
    {
      "id": "goals",
      "type": "bullets",
      "title": "…",
      "bullets": ["…", "$س$"],
      "narration": "…"
    },
    {
      "id": "solve",
      "type": "equation_steps",
      "title": "…",
      "steps": [
        { "latex": "٢س + ٦ = ١٤" },
        { "latex": "س = ٤", "note": "نقسم على ٢" }
      ],
      "narration": "…"
    },
    {
      "id": "fig",
      "type": "figure",
      "title": "…",
      "image": "fig.png",
      "callouts": ["…"],
      "narration": "…"
    }
  ]
}
```

Items (bullets, callouts, steps) appear in step with the narration's sentences. `narration_tts` overrides what the voice reads (pronunciation fixes). Maths in on-screen text goes between `$ … $`.

## Review states over `/v1/lessons`

```sh
curl -s localhost:8080/v1/lessons -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "{\"script\": $(cat lesson.json)}"
curl -s -X POST localhost:8080/v1/lessons/<id>/check   -H "authorization: Bearer $KEY"   # draft → auto_checked
npm run video -- --lesson <id> --org <org_id>                                             # renders and attaches the MP4
curl -s -X POST localhost:8080/v1/lessons/<id>/submit  -H "authorization: Bearer $KEY"   # → in_review
curl -s -X POST localhost:8080/v1/lessons/<id>/approve -H "authorization: Bearer $KEY"   # → approved
curl -s -X POST localhost:8080/v1/lessons/<id>/publish -H "authorization: Bearer $KEY"   # → published
curl -s localhost:8080/v1/lessons/<id> -H "authorization: Bearer $KEY"                   # video.url while it exists
```

Design and open items: `docs/adr/0003-explainer-video-pipeline.md`.
