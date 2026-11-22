# Reference: Hone "Engines" launch video

These files are a design reference for
[Plan 42K — Brain interface](../../history/plan-42K-brain-ui.md). The operator supplied
them on 12 October 2026.

Use the structure of these screens. Do not copy the names, the brand, the text
or the assets of Hone. The files are third-party material. Keep them inside
this repository and do not publish them.

## The video

The video is not in the repository, because its size is 155 MB.

- File name: `Hone - Today Hone launches Engines： AI that owns business
outcomes.  Chatbot... [2108214777378185216].mp4`
- Location: the operator's `~/Downloads` and `~/Desktop` directories.
- Length: 3 minutes 44 seconds. Frame: 3840 by 2160.
- SHA-256: `0800acc4fdc2e32272e6c43f9a8628eaeefa67296692dcbb0a63c8597ca08d1e`

To read one frame, give the time in seconds:

```bash
ffmpeg -ss 74 -i "<video>" -frames:v 1 -vf "crop=3200:1980:320:86,scale=1600:-1" frame.jpg
```

## The screenshots

| File                                                                   | Time | What it shows                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01-new-engine-interview.webp](01-new-engine-interview.webp)           | 1:05 | Setup as an interview. A step list on the left. The product asks one question at a time and offers answers. A rule that the operator states becomes a routine. |
| [02-brain-bootstrapping.webp](02-brain-bootstrapping.webp)             | 1:12 | The Brain page, first tab. A flow from the connected sources through the learning stages to the outputs, with a count at each box. A log of events below.      |
| [03-new-engine-systems-linked.webp](03-new-engine-systems-linked.webp) | 1:09 | The end of the interview. Each connected system is a row with its state.                                                                                       |
| [04-brain-knowledge.webp](04-brain-knowledge.webp)                     | 1:28 | The Knowledge tab. Categories with counts on the left. Rows with a title, a scope, the time of the last change and a "New" mark.                               |
| [05-overview-latest.webp](05-overview-latest.webp)                     | 1:43 | The overview. One sentence in the centre says what the agent does now.                                                                                         |
| [06-run-workflow-graph.webp](06-run-workflow-graph.webp)               | 1:50 | The workflow of one run. Three steps gather in parallel, one step combines them, one step checks, then the output. Stage names, state marks and a legend.      |
| [07-slack-delivery.webp](07-slack-delivery.webp)                       | 2:06 | The result arrives in the team's Slack channel.                                                                                                                |
| [08-under-the-hood.webp](08-under-the-hood.webp)                       | 2:52 | Three claims about the method: the harness changes itself, credit is assigned over a long time, and past cases are replayed with a change.                     |

Other parts of the video that have no screenshot here:

- 1:32: a chat in which the operator states a rule in one sentence.
- 2:32 to 2:44: a card with one business measure and its change since the
  start.
