# Local Wake Model

This directory contains the English keyword-spotting model from the sherpa-onnx
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` release.

The model is Apache-2.0 licensed. It runs locally and receives no network
traffic. The configured wake keyword is `Hey Whisper` (`keywords.txt`) and the
configured close keyword is `Stop Whisper` (`close-keywords.txt`).

## Editing the keyword files

Each keyword file holds the phrase already split into the model's BPE tokens.
Do not write that split by hand. A phrase can be made of valid tokens and still
never fire, because the spotter only matches the one segmentation the
transducer emits: `Stop Whisper` must be `▁ST O P ▁W H IS PER`, and the
token-valid `▁S T O P ▁W H IS PER` matches nothing.

Derive the tokens with `toKeywordTokens()` in
`src/main/services/wake-keywords.js`, which does greedy longest-match against
`tokens.txt`:

```
node -e "const {readTokenSet,toKeywordTokens}=require('./src/main/services/wake-keywords');console.log(toKeywordTokens('Stop Whisper', readTokenSet('src/main/assets/wake/tokens.txt')))"
```

`WakeWordService` checks each file against the derived tokens before it builds
the spotter, and `test/wake-word-service.test.js` covers both shipped files.
