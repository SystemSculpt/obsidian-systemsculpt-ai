import { pdfAiAssistantAudioCues } from "./audioCues";
import {
  getStoryboardDuration,
  type SceneSpec,
  type Storyboard,
} from "../lib/storyboard";

export const pdfAiAssistantScenes = [
  {
    id: "scene-01-problem",
    label: "PDF overload problem",
    durationInFrames: 180,
    layout: "center-lockup",
    kicker: "Context overload",
    headlineLines: ["123 PDFs.", "Zero answers."],
    supportingText: "Start with the actual import surface, not an invented dashboard.",
    accentLineIndex: 1,
    accentColor: "#FF7A59",
    background: ["#FBF6F0", "#F3E5D8"],
    surface: {
      kind: "context-modal",
      title: "Add Context Files",
      searchValue: "pdf",
      searchReveal: {
        mode: "type",
        startFrame: 8,
        durationInFrames: 42,
      },
      filters: [
        { id: "all", label: "All", active: false },
        { id: "docs", label: "Documents", icon: "file", active: true },
        { id: "text", label: "Text", icon: "file-text" },
        { id: "images", label: "Images", icon: "image" },
      ],
      rows: [
        { id: "r1", name: "Board Memo Q2.pdf", path: "Docs/Board Memo Q2.pdf", badge: "PDF", icon: "file", state: "selected" },
        { id: "r2", name: "Forecast Revision.pdf", path: "Finance/Forecast Revision.pdf", badge: "PDF", icon: "file", state: "selected" },
        { id: "r3", name: "Hiring Plan.pdf", path: "People/Hiring Plan.pdf", badge: "PDF", icon: "file" },
        { id: "r4", name: "APAC Expansion.pdf", path: "Strategy/APAC Expansion.pdf", badge: "PDF", icon: "file" },
        { id: "r5", name: "Pricing Review.pdf", path: "Revenue/Pricing Review.pdf", badge: "PDF", icon: "file" },
        { id: "r6", name: "Launch Risks.pdf", path: "Risk/Launch Risks.pdf", badge: "PDF", icon: "file" },
        { id: "r7", name: "Vendor Renewal.pdf", path: "Ops/Vendor Renewal.pdf", badge: "PDF", icon: "file" },
        { id: "r8", name: "2026 Plan.pdf", path: "Planning/2026 Plan.pdf", badge: "PDF", icon: "file" },
      ],
      primaryActionLabel: "Add 123 files",
      secondaryActionLabel: "Cancel",
    },
  },
  {
    id: "scene-02-reframe",
    label: "One assistant",
    durationInFrames: 180,
    layout: "center-lockup",
    kicker: "Same plugin",
    headlineLines: ["Now it's", "one assistant."],
    supportingText: "The chat view becomes the control surface.",
    accentLineIndex: 1,
    accentColor: "#3A7BFF",
    background: ["#F6F8FF", "#E1E8FF"],
    surface: {
      kind: "chat-status",
      toolbarChips: [
        { id: "model", label: "gpt-5.3-codex-spark", icon: "bot", tone: "accent" },
        { id: "prompt", label: "General Use", icon: "sparkles" },
      ],
      attachments: [],
      eyebrow: "Ready",
      title: "New chat",
      description:
        "Type below or attach context.",
      chips: [
        { id: "sc1", label: "Model", value: "gpt-5.3-codex-spark", icon: "bot" },
        { id: "sc2", label: "Prompt", value: "General Use", icon: "sparkles" },
        { id: "sc3", label: "Context", value: "No context yet", icon: "paperclip" },
      ],
      actions: [
        { id: "sa1", label: "Add Context", icon: "paperclip", primary: true },
        { id: "sa2", label: "Switch Prompt", icon: "sparkles" },
        { id: "sa3", label: "Switch Model", icon: "bot" },
      ],
      note: "Use / for export and debug tools once this chat is saved.",
      draft: {
        text: "",
        placeholder: "Write a message...",
      },
    },
  },
  {
    id: "scene-03-import",
    label: "Bulk import",
    durationInFrames: 240,
    layout: "split-left",
    kicker: "Shot 03",
    headlineLines: ["Drop the", "whole folder."],
    supportingText: "Use the actual composer plus attachment pills from the live plugin.",
    accentLineIndex: 1,
    accentColor: "#00A676",
    background: ["#F2FBF8", "#D7F3E8"],
    surface: {
      kind: "chat-thread",
      toolbarChips: [
        { id: "model", label: "Claude 4.1", icon: "bot", tone: "accent" },
        { id: "prompt", label: "Research Analyst", icon: "sparkles" },
        { id: "credits", label: "2.4k credits", icon: "bolt" },
      ],
      attachments: [
        { id: "b1", label: "Board Memo Q2.pdf", icon: "file", state: "ready" },
        { id: "b2", label: "Forecast Revision.pdf", icon: "file", state: "processing" },
        { id: "b3", label: "Hiring Plan.pdf", icon: "file", state: "processing" },
        { id: "b4", label: "APAC Expansion.pdf", icon: "file", state: "new" },
      ],
      messages: [
        {
          id: "m1",
          role: "system",
          paragraphs: ["Indexing 24 new documents. OCR and extraction are still running."],
          reveal: {
            mode: "stream",
            startFrame: 16,
            durationInFrames: 70,
            showCursor: true,
          },
        },
      ],
      draft: {
        text: "",
        placeholder: "Write a message...",
      },
      recording: "none",
    },
  },
  {
    id: "scene-04-query",
    label: "Ask across documents",
    durationInFrames: 240,
    layout: "split-right",
    kicker: "Shot 04",
    headlineLines: ["Ask across", "all of them."],
    supportingText: "Real thread, real composer, real reasoning block.",
    accentLineIndex: 1,
    accentColor: "#FFB800",
    background: ["#FFF9ED", "#FDE7BD"],
    surface: {
      kind: "chat-thread",
      toolbarChips: [
        { id: "model", label: "Claude 4.1", icon: "bot", tone: "accent" },
        { id: "prompt", label: "Research Analyst", icon: "sparkles" },
        { id: "credits", label: "2.3k credits", icon: "bolt" },
      ],
      attachments: [
        { id: "c1", label: "Board Memo Q2.pdf", icon: "file", state: "ready" },
        { id: "c2", label: "Forecast Revision.pdf", icon: "file", state: "ready" },
        { id: "c3", label: "Hiring Plan.pdf", icon: "file", state: "ready" },
      ],
      messages: [
        {
          id: "m2",
          role: "user",
          paragraphs: [
            "Compare the Q2 forecast with the board memo and flag contradictions."
          ],
        },
        {
          id: "m3",
          role: "assistant",
          inlineBlocks: [
            {
              id: "ib1",
              kind: "reasoning",
              title: "Reasoning",
              status: "Running",
              statusTone: "pending",
              streaming: true,
              reveal: {
                mode: "stream",
                startFrame: 34,
                durationInFrames: 96,
                lineDelayInFrames: 18,
                showCursor: true,
              },
              textLines: [
                "Searching attached documents for planning assumptions and changed numbers.",
                "Prioritizing sections that mention hiring, launch timing, and budget deltas.",
              ],
            },
          ],
        },
      ],
      draft: {
        text: "What changed between the Q2 forecast and the board memo?",
        reveal: {
          mode: "type",
          startFrame: 0,
          durationInFrames: 104,
        },
      },
      stopVisible: true,
    },
  },
  {
    id: "scene-05-citations",
    label: "Citations",
    durationInFrames: 240,
    layout: "split-left",
    kicker: "Shot 05",
    headlineLines: ["Real answers.", "Real citations."],
    supportingText: "Keep the citation footer on the actual message surface.",
    accentLineIndex: 1,
    accentColor: "#8D5CF6",
    background: ["#F7F3FF", "#E7DBFF"],
    surface: {
      kind: "chat-thread",
      toolbarChips: [
        { id: "model", label: "Claude 4.1", icon: "bot", tone: "accent" },
        { id: "prompt", label: "Research Analyst", icon: "sparkles" },
        { id: "credits", label: "2.2k credits", icon: "bolt" },
      ],
      attachments: [
        { id: "d1", label: "Board Memo Q2.pdf", icon: "file", state: "ready" },
        { id: "d2", label: "Forecast Revision.pdf", icon: "file", state: "ready" },
        { id: "d3", label: "Hiring Plan.pdf", icon: "file", state: "ready" },
      ],
      messages: [
        {
          id: "m4",
          role: "user",
          paragraphs: [
            "Compare the Q2 forecast with the board memo and flag contradictions."
          ],
        },
        {
          id: "m5",
          role: "assistant",
          paragraphs: [
            "Three contradictions stand out. The forecast assumes hiring resumes in July, while the board memo freezes headcount until October.",
            "The forecast also keeps the APAC launch in Q3, but the board memo pushes approval into late Q4.",
          ],
          citations: [
            {
              id: "ct1",
              title: "Board Memo Q2",
              url: "https://vault.local/Docs/Board-Memo-Q2",
              snippet: "Headcount remains frozen through October pending board approval.",
            },
            {
              id: "ct2",
              title: "Forecast Revision",
              url: "https://vault.local/Finance/Forecast-Revision",
              snippet: "Updated model resumes hiring on July 15 and preserves Q3 expansion timing.",
            },
            {
              id: "ct3",
              title: "Hiring Plan",
              url: "https://vault.local/People/Hiring-Plan",
              snippet: "Role openings are contingent on the July forecast scenario.",
            },
          ],
        },
      ],
      draft: {
        text: "",
        placeholder: "Ask a follow-up...",
      },
    },
  },
  {
    id: "scene-06-disagreement",
    label: "Compare disagreement",
    durationInFrames: 240,
    layout: "split-right",
    kicker: "Shot 06",
    headlineLines: ["See where", "they disagree."],
    supportingText: "Lean on the live tool-call block instead of inventing a special compare UI.",
    accentLineIndex: 1,
    accentColor: "#FF5A87",
    background: ["#FFF3F6", "#FFD7E0"],
    surface: {
      kind: "chat-thread",
      toolbarChips: [
        { id: "model", label: "Claude 4.1", icon: "bot", tone: "accent" },
        { id: "prompt", label: "Research Analyst", icon: "sparkles" },
        { id: "credits", label: "2.1k credits", icon: "bolt" },
      ],
      attachments: [
        { id: "e1", label: "Board Memo Q2.pdf", icon: "file", state: "ready" },
        { id: "e2", label: "Forecast Revision.pdf", icon: "file", state: "ready" },
        { id: "e3", label: "Hiring Plan.pdf", icon: "file", state: "ready" },
      ],
      messages: [
        {
          id: "m6",
          role: "assistant",
          paragraphs: [
            "The board memo and forecast disagree on hiring, launch timing, and spend approval."
          ],
          bullets: [
            "Hiring resumes in July in the forecast, but the memo freezes headcount until October.",
            "The forecast keeps APAC in Q3, while the memo delays approval until late Q4.",
            "Marketing spend expands in the forecast but is capped in the memo until board review.",
          ],
          inlineBlocks: [
            {
              id: "ib2",
              kind: "tool_call",
              title: "Activity",
              status: "Completed",
              statusTone: "success",
              lines: [
                { id: "l1", prefix: "1.", label: "search_documents", detail: "123 files scanned" },
                { id: "l2", prefix: "2.", label: "compare_sections", detail: "board memo vs forecast" },
                { id: "l3", prefix: "3.", label: "extract_conflicts", detail: "3 contradictions found" },
              ],
            },
          ],
        },
      ],
      draft: {
        text: "Show me the disagreements only.",
      },
    },
  },
  {
    id: "scene-07-summary",
    label: "Summary output",
    durationInFrames: 240,
    layout: "split-left",
    kicker: "Shot 07",
    headlineLines: ["Summaries", "in seconds."],
    supportingText: "Stay in the same thread and use the real activity block for note creation.",
    accentLineIndex: 1,
    accentColor: "#0F9DFF",
    background: ["#F2FAFF", "#D3EDFF"],
    surface: {
      kind: "chat-thread",
      toolbarChips: [
        { id: "model", label: "Claude 4.1", icon: "bot", tone: "accent" },
        { id: "prompt", label: "Research Analyst", icon: "sparkles" },
        { id: "credits", label: "2.0k credits", icon: "bolt" },
      ],
      attachments: [
        { id: "f1", label: "Board Memo Q2.pdf", icon: "file", state: "ready" },
        { id: "f2", label: "Forecast Revision.pdf", icon: "file", state: "ready" },
      ],
      messages: [
        {
          id: "m7",
          role: "user",
          paragraphs: ["Turn this into a study guide and save it to a note."],
        },
        {
          id: "m8",
          role: "assistant",
          paragraphs: ["Study guide created. Key takeaways:"],
          bullets: [
            "Where the forecast and board memo diverge",
            "Which assumptions changed after July planning",
            "What to revisit before the next board review",
          ],
          inlineBlocks: [
            {
              id: "ib3",
              kind: "tool_call",
              title: "Activity",
              status: "Saved",
              statusTone: "success",
              lines: [
                { id: "l4", prefix: "1.", label: "write_note", detail: "Board Review Study Guide.md" },
                { id: "l5", prefix: "2.", label: "link_sources", detail: "6 citations added" },
              ],
            },
          ],
        },
      ],
      draft: {
        text: "",
        placeholder: "Ask another question...",
      },
    },
  },
  {
    id: "scene-08-lockup",
    label: "Final lockup",
    durationInFrames: 240,
    layout: "center-lockup",
    kicker: "SystemSculpt for Obsidian",
    headlineLines: ["Chat with 100 PDFs", "like one assistant."],
    supportingText: "End on the real chat product, not an abstract card.",
    accentLineIndex: 0,
    accentColor: "#121417",
    background: ["#F8F8F6", "#EAE8E1"],
    surface: {
      kind: "chat-thread",
      toolbarChips: [
        { id: "model", label: "Claude 4.1", icon: "bot", tone: "accent" },
        { id: "prompt", label: "Research Analyst", icon: "sparkles" },
        { id: "credits", label: "1.9k credits", icon: "bolt" },
      ],
      attachments: [
        { id: "g1", label: "Board Memo Q2.pdf", icon: "file", state: "ready" },
        { id: "g2", label: "Forecast Revision.pdf", icon: "file", state: "ready" },
        { id: "g3", label: "Hiring Plan.pdf", icon: "file", state: "ready" },
      ],
      messages: [
        {
          id: "m9",
          role: "assistant",
          paragraphs: [
            "I can keep comparing, summarizing, and drafting notes across every attached document in this chat."
          ],
          citations: [
            {
              id: "ct4",
              title: "Board Memo Q2",
              url: "https://vault.local/Docs/Board-Memo-Q2",
            },
            {
              id: "ct5",
              title: "Forecast Revision",
              url: "https://vault.local/Finance/Forecast-Revision",
            },
          ],
        },
      ],
      draft: {
        text: "",
        placeholder: "Ask across your documents...",
      },
    },
  },
] as const satisfies readonly SceneSpec[];

export const pdfAiAssistantStoryboard: Storyboard = {
  id: "pdf-ai-assistant-30",
  title: "PDF AI Assistant 30",
  fps: 60,
  width: 1920,
  height: 1080,
  durationInFrames: getStoryboardDuration(pdfAiAssistantScenes),
  scenes: pdfAiAssistantScenes,
  audioCueMap: pdfAiAssistantAudioCues,
};

if (pdfAiAssistantStoryboard.durationInFrames !== 1800) {
  throw new Error(
    `PDF AI assistant storyboard must be 1800 frames, received ${pdfAiAssistantStoryboard.durationInFrames}.`
  );
}
