/**
 * Licence gate for public/audio/.
 *
 *   npm run check-tracks
 *
 * Fails the build if any audio file lacks a manifest entry, or has one whose
 * licence is not on the allowed list. The point is that it is impossible to
 * ship an audio file by accident: the check runs before every build.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const AUDIO_DIR = resolve(process.cwd(), 'public/audio');
const MANIFEST = resolve(AUDIO_DIR, 'tracks.json');
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.opus', '.wav', '.flac', '.m4a', '.aac', '.webm']);

interface Track {
  file: string;
  title: string;
  artist: string;
  licence: string;
  source: string;
}

interface Manifest {
  allowedLicences?: string[];
  tracks?: Track[];
}

const REQUIRED: (keyof Track)[] = ['file', 'title', 'artist', 'licence', 'source'];

function main(): void {
  const problems: string[] = [];

  if (!existsSync(MANIFEST)) {
    console.error(`check-tracks: ${MANIFEST} is missing.`);
    process.exit(1);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  } catch (err) {
    console.error(`check-tracks: tracks.json is not valid JSON — ${(err as Error).message}`);
    process.exit(1);
  }

  const allowed = new Set((manifest.allowedLicences ?? []).map((l) => l.toLowerCase()));
  if (allowed.size === 0) {
    problems.push('tracks.json has no allowedLicences list, so nothing could ever pass.');
  }

  const tracks = manifest.tracks ?? [];
  const byFile = new Map<string, Track>();

  tracks.forEach((track, i) => {
    for (const field of REQUIRED) {
      if (!track[field] || String(track[field]).trim() === '') {
        problems.push(`tracks[${i}] is missing "${field}".`);
      }
    }
    if (track.licence && !allowed.has(track.licence.toLowerCase())) {
      problems.push(
        `tracks[${i}] ("${track.title ?? track.file}") has licence "${track.licence}", which is not allowed. ` +
          `Allowed: ${(manifest.allowedLicences ?? []).join(', ')}.`,
      );
    }
    if (track.file) {
      if (byFile.has(track.file)) problems.push(`Two entries claim the same file: ${track.file}`);
      byFile.set(track.file, track);
      if (!existsSync(resolve(AUDIO_DIR, track.file))) {
        problems.push(`tracks[${i}] points at ${track.file}, which is not in public/audio/.`);
      }
    }
  });

  const present = existsSync(AUDIO_DIR)
    ? readdirSync(AUDIO_DIR).filter((f) => AUDIO_EXT.has(f.slice(f.lastIndexOf('.')).toLowerCase()))
    : [];

  for (const file of present) {
    if (!byFile.has(file)) {
      problems.push(`${file} is in public/audio/ but has no entry in tracks.json. Add one, or delete the file.`);
    }
  }

  if (problems.length > 0) {
    console.error('check-tracks: FAILED\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n${problems.length} problem(s). See TRACKS.md for sources with acceptable licences.`);
    process.exit(1);
  }

  console.log(
    present.length === 0
      ? 'check-tracks: OK — no audio files bundled. The generator is licence-free by construction.'
      : `check-tracks: OK — ${present.length} file(s), all with an allowed licence.`,
  );
}

main();
