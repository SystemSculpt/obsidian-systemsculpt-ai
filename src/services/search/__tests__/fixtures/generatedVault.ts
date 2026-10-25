import { TFile } from "obsidian";

/**
 * Deterministic synthetic vault for search ranking and memory tests.
 *
 * Every read builds the note's text again from its seed, so nothing outside
 * the code under test keeps note text alive: a heap measurement then counts
 * only what the search index itself retains.
 */
export interface GeneratedVault {
  files: TFile[];
  read(file: TFile): string;
  /** A sample of words by frequency rank, for building queries. */
  lexicon: readonly string[];
}

export interface GeneratedVaultOptions {
  notes: number;
  seed: number;
  now: number;
  /** Median note length in characters. */
  medianChars: number;
  /** Extra hand-written notes, merged into the generated ones. */
  extraNotes?: Record<string, { text: string; mtime: number }>;
}

const COMMON_WORDS = (
  "the of and to in is for on that with as it this be by are from at or an was not have but we can will " +
  "project meeting notes plan review weekly daily idea draft task follow up research reading book summary " +
  "orange juice fresh harvest launch release budget client design system workflow template checklist " +
  "journal health habit sleep workout recipe travel garden finance invoice contract roadmap feedback " +
  "decision question answer problem solution context summary agenda action items next steps owner"
).split(" ");

const ACCENTED_WORDS = ["café", "über", "naïve", "résumé", "smörgåsbord", "jalapeño", "façade", "zürich"];
const CYRILLIC_WORDS = ["привет", "мир", "заметка", "встреча", "проект"];
const CJK_PHRASES = ["会議メモ", "東京の会議", "京都の旅行", "プロジェクト計画", "読書ノート"];
const EMOJI = ["🚀", "✅", "📌", "🔥", "🧠"];
const PUNCTUATED = ["co-op", "don't", "e-mail", "follow-up", "c++", "node.js", "q&a", "self-review"];
const FOLDERS = [
  "Projects/Alpha", "Projects/Beta", "Projects/Gamma Launch", "Daily/2024", "Daily/2025", "Areas/Health",
  "Areas/Finance", "Areas/Home", "Resources/Reading", "Resources/Recipes", "Resources/Research Papers",
  "Archive/2023", "Archive/Old Clients", "Meetings", "Inbox", "Journal", "Templates", "People", "Travel",
  "Work/Clients/Acme", "Work/Clients/Globex", "Work/Reviews", "Ideas", "Writing/Drafts", "Writing/Published",
];
const SYLLABLES = (
  "ba be bi bo bu ca ce ci co cu da de di do du fa fe fi fo fu ga ge gi go gu ha he hi ho hu ja je jo ka ke ki ko ku " +
  "la le li lo lu ma me mi mo mu na ne ni no nu pa pe pi po pu ra re ri ro ru sa se si so su ta te ti to tu va ve vi " +
  "vo wa we wi wo ya yo za ze zi zo tra tre tri pro pla ple pri bra bre cla cre dra fra gra gro sta ste sti str " +
  "nth ndo rk sh ch th ph ng ck lt rm rn st"
).split(" ");

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLexicon(seed: number, size: number): string[] {
  const random = mulberry32(seed);
  const words = new Set<string>(COMMON_WORDS);
  while (words.size < size) {
    const syllables = 1 + Math.floor(random() * 4);
    let word = "";
    for (let index = 0; index < syllables; index += 1) {
      word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    }
    if (word.length > 2) words.add(word);
  }
  return Array.from(words);
}

/** Zipf sampler over lexicon ranks (exponent 1.07, like natural text). */
function buildZipfTable(size: number): Float64Array {
  const table = new Float64Array(size);
  let total = 0;
  for (let rank = 0; rank < size; rank += 1) {
    total += 1 / Math.pow(rank + 1, 1.07);
    table[rank] = total;
  }
  for (let rank = 0; rank < size; rank += 1) table[rank] /= total;
  return table;
}

function sampleRank(table: Float64Array, value: number): number {
  let low = 0;
  let high = table.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (table[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

interface NoteSpec {
  path: string;
  mtime: number;
  seed: number;
  targetChars: number;
}

export function generateVault(options: GeneratedVaultOptions): GeneratedVault {
  const lexicon = buildLexicon(options.seed, 24_000);
  const zipf = buildZipfTable(lexicon.length);
  const random = mulberry32(options.seed ^ 0x9e3779b9);
  const word = (rand: () => number) => lexicon[sampleRank(zipf, rand())];

  const specs: NoteSpec[] = [];
  const titles: string[] = [];
  const usedPaths = new Set<string>();
  for (let index = 0; index < options.notes; index += 1) {
    const folder = pick(random, FOLDERS);
    const titleWords = 1 + Math.floor(random() * 4);
    const parts: string[] = [];
    for (let part = 0; part < titleWords; part += 1) parts.push(capitalize(word(random)));
    let title = parts.join(" ");
    if (random() < 0.2) title = `${title} ${2020 + Math.floor(random() * 6)}`;
    let path = `${folder}/${title}.md`;
    for (let suffix = 2; usedPaths.has(path.toLowerCase()); suffix += 1) path = `${folder}/${title} ${suffix}.md`;
    if (index % 97 === 13) path = path.replace(/\.md$/u, ".canvas");
    usedPaths.add(path.toLowerCase());
    titles.push(title);
    // Log-normal note lengths, with a long tail of very large notes.
    const gaussian = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const targetChars = Math.min(400_000, Math.max(40, Math.round(options.medianChars * Math.exp(gaussian))));
    // Most notes are old; some changed today, this week and this month.
    const ageRoll = random();
    const ageDays = ageRoll < 0.03 ? random() : ageRoll < 0.1 ? 1 + random() * 6 : ageRoll < 0.25 ? 7 + random() * 23 : 30 + random() * 900;
    specs.push({
      path,
      mtime: Math.round(options.now - ageDays * 86_400_000),
      seed: Math.floor(random() * 0xffffffff),
      targetChars,
    });
  }

  const textFor = (spec: NoteSpec): string => {
    const rand = mulberry32(spec.seed);
    const markdown = buildMarkdown(spec, rand, word, titles);
    if (!spec.path.endsWith(".canvas")) return markdown;
    const nodes = markdown.split(/\n\n+/u).slice(0, 40).map((text, index) => ({
      id: `n${index}`,
      type: "text",
      text,
      x: index * 10,
      y: index * 20,
      width: 400,
      height: 200,
    }));
    return JSON.stringify({ nodes, edges: [] });
  };

  const files: TFile[] = [];
  const bySeedPath = new Map<string, NoteSpec>();
  for (const spec of specs) {
    files.push(new TFile({ path: spec.path, stat: { mtime: spec.mtime, ctime: spec.mtime, size: spec.targetChars } }));
    bySeedPath.set(spec.path, spec);
  }
  const extras = options.extraNotes ?? {};
  for (const [path, note] of Object.entries(extras)) {
    files.push(new TFile({ path, stat: { mtime: note.mtime, ctime: note.mtime, size: note.text.length } }));
  }

  return {
    files,
    lexicon,
    read(file: TFile): string {
      const extra = extras[file.path];
      if (extra) return extra.text;
      const spec = bySeedPath.get(file.path);
      return spec ? textFor(spec) : "";
    },
  };
}

function buildMarkdown(
  spec: NoteSpec,
  rand: () => number,
  word: (rand: () => number) => string,
  titles: readonly string[],
): string {
  const out: string[] = [];
  if (rand() < 0.6) {
    out.push(
      "---",
      `tags: [${word(rand)}, ${word(rand)}]`,
      `created: 2024-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`,
      `status: ${pick(rand, ["draft", "active", "done", "someday"])}`,
      "---",
    );
  }
  const typography = rand() < 0.3;
  let length = out.join("\n").length;
  let paragraph = 0;
  while (length < spec.targetChars) {
    const block: string[] = [];
    const roll = rand();
    if (paragraph % 6 === 0) {
      block.push(`${paragraph === 0 ? "#" : "##"} ${capitalize(word(rand))} ${word(rand)}`);
    } else if (roll < 0.12) {
      for (let item = 0; item < 3 + Math.floor(rand() * 4); item += 1) {
        block.push(`- [${rand() < 0.5 ? "x" : " "}] ${word(rand)} ${word(rand)} ${word(rand)} [[${pick(rand, titles)}]]`);
      }
    } else if (roll < 0.15) {
      block.push("```js", `const ${word(rand)}Value = ${Math.floor(rand() * 1000)}; // ${word(rand)}`, "```");
    } else {
      const sentences = 2 + Math.floor(rand() * 5);
      const parts: string[] = [];
      for (let sentence = 0; sentence < sentences; sentence += 1) {
        const words: string[] = [];
        const count = 6 + Math.floor(rand() * 14);
        for (let index = 0; index < count; index += 1) {
          const special = rand();
          if (special < 0.004) words.push(pick(rand, ACCENTED_WORDS));
          else if (special < 0.006) words.push(pick(rand, CYRILLIC_WORDS));
          else if (special < 0.008) words.push(pick(rand, CJK_PHRASES));
          else if (special < 0.0095) words.push(pick(rand, EMOJI));
          else if (special < 0.013) words.push(pick(rand, PUNCTUATED));
          else if (special < 0.016) words.push(`#${word(rand)}`);
          else if (special < 0.018) words.push(`https://example.com/${word(rand)}/${Math.floor(rand() * 1e8).toString(16)}`);
          else if (special < 0.021) words.push(`${Math.floor(rand() * 10_000)}`);
          else if (special < 0.023) words.push(`${word(rand)}${word(rand)}${word(rand)}${word(rand)}`);
          else words.push(word(rand));
        }
        const text = words.join(" ");
        parts.push(`${capitalize(text)}${typography && rand() < 0.2 ? " — “quoted”" : ""}.`);
      }
      block.push(parts.join(" "));
    }
    const text = block.join("\n");
    out.push("", text);
    length += text.length + 1;
    paragraph += 1;
  }
  return out.join("\n");
}
