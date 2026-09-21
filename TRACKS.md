# Tracks

Fly DJ ships with **no audio files**. The built-in generator is licence-free by
construction, and you can drop your own files in without them ever leaving your
machine.

If you want to bundle music with a deployment, put the files in `public/audio/`
and add an entry to `public/audio/tracks.json` for each one.
`npm run check-tracks` runs before every build and fails if a file has no entry
or carries a licence outside the allowed list.

## Allowed licences

- **CC0** — public domain dedication, no attribution required (but be decent).
- **CC BY 4.0 / CC BY 3.0** — attribution required.
- **CC BY-SA 4.0** — attribution required, share-alike.
- **Pixabay Content License**.

Anything else fails the check. That includes "free to use" pages with no stated
licence: if you cannot name the licence, you cannot ship the file.

## Manifest format

```json
{
  "allowedLicences": ["CC0", "CC BY 4.0", "Pixabay Content License"],
  "tracks": [
    {
      "file": "example-loop.mp3",
      "title": "Example Loop",
      "artist": "Some Artist",
      "licence": "CC BY 4.0",
      "source": "https://example.org/the-page-you-got-it-from"
    }
  ]
}
```

`source` must be the page you actually downloaded from, not a search result —
it is what the Credits panel links to, and what lets anyone verify the licence.

## Where to look

| Source | Notes |
|---|---|
| [Pixabay Music](https://pixabay.com/music/) | Pixabay Content License. Large electronic selection. |
| [Free Music Archive](https://freemusicarchive.org/) | Filter to CC0 or CC BY. Check each track: the FMA hosts several licences. |
| [ccMixter](https://ccmixter.org/) | Mostly CC BY and CC BY-NC. **NC tracks are not allowed here** — this project has no commercial use, but NC is a licence-compatibility trap, so it stays off the list. |
| [Incompetech](https://incompetech.com/music/royalty-free/) | Kevin MacLeod, CC BY 4.0. Attribution wording is specified on each track's page; copy it verbatim into `artist`. |

## What actually suits the fly

For the joke to land you want contrast:

- Something with a **hard four-on-the-floor kick and busy hats**. The fly will
  ignore it completely, which is the baseline.
- Something with a **prominent 16th-note bass line around 60-80 Hz**. Turn on
  Auto-fit and the fly resizes itself until the bass line lands on its
  preferred inter-pulse interval.
- Anything with **sustained content near 250 Hz** — a low-mid synth lead, a
  male vocal — will get through to a normal-sized fly.

Tracks that are mostly pads and reverb produce almost no onsets and read as
near-silence to the model. They are dull to watch.
