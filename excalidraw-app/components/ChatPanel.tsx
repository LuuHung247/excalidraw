import { useState, useRef, useEffect, useCallback } from "react";

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import "./ChatPanel.scss";

const MAX_HEIGHT = 200;
const AGENT_URL = "http://localhost:8000";

// ─── Easing: giống After Effects ease in-out ─────────────────────────────────
function easeInOut(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ─── Stroke + Label types ────────────────────────────────────────────────────
interface StrokeData {
  points: number[][];
  color: string;
  strokeWidth: number;
  closed?: boolean;
}

interface LabelData {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

// ─── Chuẩn bị: tạo full Excalidraw elements 1 lần (có đầy đủ internal fields)
function prepareElements(strokes: StrokeData[], labels: LabelData[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skeletons: any[] = [];
  const smoothData: { relative: number[][]; minX: number; minY: number }[] = [];

  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const pts = s.points;
    const xs = pts.map((pt: number[]) => pt[0]);
    const ys = pts.map((pt: number[]) => pt[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const relative = pts.map((pt: number[]) => [pt[0] - minX, pt[1] - minY]);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    smoothData.push({ relative, minX, minY });

    // line element với roundness type 3 → Excalidraw tự bẻ cong qua waypoints
    skeletons.push({
      type: "line",
      id: `stroke-${i}`,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      points: relative,
      strokeColor: s.color,
      strokeWidth: s.strokeWidth ?? 2,
      fillStyle: "hachure",
      roughness: 0,
      opacity: 100,
      strokeStyle: "solid",
      backgroundColor: "transparent",
      angle: 0,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      boundElements: null,
      link: null,
      locked: false,
      isDeleted: false,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
    });
  }

  // Labels
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    skeletons.push({
      type: "text" as const,
      id: `label-${i}`,
      x: l.x,
      y: l.y,
      text: l.text,
      fontSize: l.fontSize,
      strokeColor: l.color,
    });
  }

  // Convert qua Excalidraw để có đầy đủ internal fields
  const fullElements = convertToExcalidrawElements(skeletons);

  return { fullElements, smoothData, strokeCount: strokes.length };
}

// ─── AE-style animation engine ───────────────────────────────────────────────
function runAnimation(
  strokes: StrokeData[],
  labels: LabelData[],
  api: ExcalidrawImperativeAPI,
  onProgress: (current: number, total: number) => void,
  onDone: () => void,
): void {
  const { fullElements, smoothData, strokeCount } = prepareElements(
    strokes,
    labels,
  );

  // Duration cho mỗi stroke
  const durations = smoothData.map((s) =>
    Math.min(2000, Math.max(300, s.relative.length * 30)),
  );

  // Stagger timing (70% overlap giữa strokes)
  const startTimes: number[] = [];
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    startTimes.push(acc);
    acc += durations[i] * 0.3;
  }
  const strokeEndTime =
    durations.length > 0 ? acc + durations[durations.length - 1] * 0.7 : 0;

  // Labels fade in sau strokes
  const labelFadeDuration = 400;
  const fullDuration = strokeEndTime + labelFadeDuration;

  const t0 = performance.now();

  function frame(now: number) {
    const elapsed = now - t0;

    // Clone elements array để modify
    const frameElements = fullElements.map((el, idx) => {
      // Stroke elements: trim points theo progress
      if (idx < strokeCount) {
        const localElapsed = elapsed - startTimes[idx];
        if (localElapsed <= 0) {
          // Chưa tới lúc → ẩn
          return { ...el, isDeleted: true };
        }

        const rawProgress = Math.min(localElapsed / durations[idx], 1);
        const progress = easeInOut(rawProgress);
        const totalPts = smoothData[idx].relative.length;
        const visibleCount = Math.max(2, Math.floor(progress * totalPts));
        const trimmedPoints = smoothData[idx].relative.slice(0, visibleCount);

        return {
          ...el,
          points: trimmedPoints,
          isDeleted: false,
          version: (el.version || 1) + 1,
        };
      }

      // Label elements: fade in ở cuối
      const labelIdx = idx - strokeCount;
      if (labelIdx >= 0) {
        const labelProgress = Math.min(
          Math.max(0, elapsed - strokeEndTime) / labelFadeDuration,
          1,
        );
        return {
          ...el,
          opacity: Math.round(labelProgress * 100),
          isDeleted: labelProgress <= 0,
          version: (el.version || 1) + 1,
        };
      }

      return el;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.updateScene({ elements: frameElements as any });

    // Progress tracking
    let completed = 0;
    for (let i = 0; i < strokeCount; i++) {
      const localElapsed = elapsed - startTimes[i];
      if (localElapsed >= durations[i]) {
        completed++;
      }
    }
    onProgress(completed, strokeCount);

    if (elapsed < fullDuration) {
      requestAnimationFrame(frame);
    } else {
      const els = api.getSceneElements();
      if (els.length > 0) {
        api.scrollToContent(els, { fitToViewport: true, animate: true });
      }
      onDone();
    }
  }

  requestAnimationFrame(frame);
}

// ─── Component ────────────────────────────────────────────────────────────────
interface Props {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export const ChatPanel = ({ excalidrawAPI }: Props) => {
  const [input, setInput] = useState("");
  const [isDrawing, setIsDrawing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isDrawing || !excalidrawAPI) {
      return;
    }

    setInput("");
    setIsDrawing(true);
    setStatus("Đang gửi tới agent...");
    excalidrawAPI.updateScene({ elements: [] });

    try {
      const res = await fetch(`${AGENT_URL}/draw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        setStatus(`Lỗi agent: ${res.status}`);
        setIsDrawing(false);
        return;
      }

      const data = await res.json();

      if (!data.success) {
        setStatus(data.error || "Agent lỗi");
        setIsDrawing(false);
        return;
      }

      const strokeCount = data.strokes?.length ?? 0;
      const labelCount = data.labels?.length ?? 0;

      if (strokeCount === 0 && labelCount === 0) {
        setStatus("Agent không trả về nét nào");
        setIsDrawing(false);
        return;
      }

      setStatus(`Đang vẽ ${strokeCount} nét...`);

      runAnimation(
        data.strokes ?? [],
        data.labels ?? [],
        excalidrawAPI,
        (completed, total) => {
          setStatus(`Đang vẽ... ${completed}/${total} nét`);
        },
        () => {
          setStatus("Vẽ xong!");
          setTimeout(() => {
            setStatus("");
          }, 3000);
          setIsDrawing(false);
        },
      );
    } catch (err) {
      setStatus(`Lỗi: ${err instanceof Error ? err.message : String(err)}`);
      setIsDrawing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="prompt-overlay">
      {status && <div className="prompt-overlay__status">{status}</div>}
      <div className="prompt-overlay__box">
        <textarea
          ref={textareaRef}
          className="prompt-overlay__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Mô tả điều bạn muốn vẽ..."
          rows={1}
          disabled={isDrawing}
        />
        <button
          className="prompt-overlay__btn"
          onClick={handleSubmit}
          disabled={isDrawing || !input.trim()}
        >
          {isDrawing ? "◌" : "▶"}
        </button>
      </div>
    </div>
  );
};
