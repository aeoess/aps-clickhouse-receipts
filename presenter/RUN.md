# Presenter agent run, 2026-06-12

The demo video was produced by a receipted presenter agent. The coordinator
registered agent:pitch-presenter through src/controlplane-adapter.ts with the
scope query_receipts, render_visual, synthesize_voice, compose_video, then
issued a receipt-gated dispatch for every pipeline step of the video build:
receipt first, then the step ran. One dispatch, publish_video, was
deliberately outside the delegated scope: denied live, receipted, never
executed. All receipts are in the local aps_receipts table.

## Step log (verbatim dispatcher output)

```
registered agent:pitch-presenter scope=query_receipts,render_visual,synthesize_voice,compose_video
dispatch synthesize_voice decision=permit receipt=prec_6268c968-917
dispatch render_visual    decision=permit receipt=prec_147314b9-228
dispatch query_receipts   decision=permit receipt=prec_75083044-5a2
dispatch compose_video    decision=permit receipt=prec_5bb47c38-2f1
dispatch publish_video    decision=deny   receipt=pdec_89a3dcd1-18c
         publish_video did not execute (no delegated authority)
verifyTrail agent:pitch-presenter: 5/5 rows PASS (ok=true)
```

## Step to pipeline mapping

| Receipt | Tool | Pipeline step |
|---|---|---|
| prec_6268c968-917 | synthesize_voice | narration, one MP3 per beat (9 beats) |
| prec_147314b9-228 | render_visual | terminal frames, ASCII face beats 1 and 9, captures |
| prec_75083044-5a2 | query_receipts | pull these rows live for the beat 9 screen |
| prec_5bb47c38-2f1 | compose_video | segments, mux at beat offsets, loudnorm, encode |
| pdec_89a3dcd1-18c | publish_video | denied: publishing was never delegated |

The beat 9 screen in the video renders exactly this log, pulled from the
store, over the presenter's portrait. The deny is the point: the pitch was
delegated, the authority to publish was not.

## Video facts

- Output: ~/Desktop/aps-demo-video.mp4, 2:53.8, 1920x1080, 30fps, H.264 +
  AAC 192k, faststart.
- Narration: 9 beats, en-US-AndrewNeural neural voice (an ElevenLabs path is
  specified in the build prompt; no key exists on this machine, so the build
  used the free neural voice and says so).
- Beat texts verbatim from the script file, with the upgraded beat 7 variant
  (the live Guild CLI run in guild-live/RUN.md is green) and the new beat 9.
- All terminal content in the video is real captured output: demo.sh,
  examples/controlplane-demo.ts, and this dispatcher.
- Reproduce the dispatch: `CLICKHOUSE_PASSWORD=aps_demo npx tsx presenter/dispatch.ts`
  (new agent identity and fresh receipts each run).
