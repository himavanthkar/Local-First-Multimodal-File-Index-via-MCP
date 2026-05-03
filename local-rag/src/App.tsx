import { useEffect, useRef, useState } from "react";
import { Box, Button, Icon } from "@mui/material";
import type { SearchResult, Msg, LlamaStatus } from "./types/global";
import AppShell from "./components/layout/AppShell";
import SidebarNav, { type NavKey } from "./components/layout/SidebarNav";
import MainCanvas from "./components/layout/MainCanvas";
import ChatThreadTopBar from "./components/chatThread/ChatThreadTopBar";

// Screens
import HomeScreen from "./components/screens/HomeScreen";
import ChatScreen from "./components/screens/ChatScreen";
import FilesScreen from "./components/screens/FilesScreen";
import VaultAppsScreen from "./components/screens/VaultAppsScreen";
import HistoryScreen from "./components/screens/HistoryScreen.tsx";
import SettingsScreen from "./components/screens/SettingsScreen";
import PrivacyAboutScreen from "./components/screens/PrivacyAboutScreen";

import { packForChatPrefix } from "./utils/contextPacker";

const NAV_LABELS: Record<NavKey, string> = {
    home: 'Home',
    chat: 'Chat',
    files: 'Files',
    vault: 'Vault / Apps',
    history: 'History',
    settings: 'Settings',
    about: 'Privacy',
};

type AppProps = {
    selectedTheme: 'light' | 'dark';
    onToggleTheme: () => void;
};

const MAX_IMAGE_CAPTIONS_PER_QUERY = 2;
const MAX_VISUAL_QA_IMAGES = 2;
const MIN_OCR_TEXT_LEN = 4;
const DEBUG_IMAGE_TEXT_ROUTING = true;

// Prompt-size guards so we never overrun llama-server's 8192 ctx
const MAX_CHARS_PER_RAG_RESULT = 600;
const MAX_RAG_PREFIX_CHARS = 3500;
const MAX_VISUAL_QA_CONTEXT_CHARS = 1200;
const MAX_AUGMENTED_USER_CHARS = 6000;
const MAX_HISTORY_MESSAGES = 6; // excludes the leading system prompt
const CHAT_HISTORY_STORAGE_KEY = "obi-chat-history-v1";
const CHAT_FOCUS_MODE_STORAGE_KEY = "obi-chat-focus-mode-v1";
const MAX_STORED_CHAT_SESSIONS = 30;
const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful assistant for local RAG. " +
    "Always ground answers in retrieved context when available. " +
    "When retrieved image captions are present, treat them as visual observations. " +
    "When OCR text is present, treat it as extracted text from the image. " +
    "Do not say you cannot see images if caption context is provided.";

type ChatSession = {
    id: string;
    title: string;
    createdAtMs: number;
    updatedAtMs: number;
    messages: Msg[];
    lastRetrieved: SearchResult[];
};

function App({ selectedTheme, onToggleTheme }: AppProps) {
    /********************************************
    * Layout States
    ********************************************/
    const [sideNavActiveItem, setSideNavActiveItem] = useState<NavKey>('home');
    const [focusMode, setFocusMode] = useState<boolean>(() => {
        try {
            return localStorage.getItem(CHAT_FOCUS_MODE_STORAGE_KEY) === "1";
        } catch {
            return false;
        }
    });

    /********************************************
    * States
    - Chat Model
    - Embedding Model
    - File Watcher
    ********************************************/
    const [starting, setStarting] = useState(true);

    // Chat Model
    const [chatModelStatus, setChatModelStatus] = useState<LlamaStatus | null>(null);

    // Messages
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<Msg[]>([
        {
            role: "system",
            content: DEFAULT_SYSTEM_PROMPT,
        },
    ]);

    // Chat Stream
    const [lastRetrieved, setLastRetrieved] = useState<SearchResult[]>([]);
    const [lastImageResults, setLastImageResults] = useState<SearchResult[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [chatHistory, setChatHistory] = useState<ChatSession[]>(loadChatHistory);
    const [activeSessionId, setActiveSessionId] = useState(() => createSessionId());

    const messagesRef = useRef<Msg[]>(messages);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        const nonSystemMessages = messages.filter((message) => message.role !== "system");
        if (!nonSystemMessages.length) return;

        setChatHistory((prev) => {
            const now = Date.now();
            const existing = prev.find((session) => session.id === activeSessionId);
            const createdAtMs = existing?.createdAtMs ?? now;
            const nextSession: ChatSession = {
                id: activeSessionId,
                title: deriveSessionTitle(messages),
                createdAtMs,
                updatedAtMs: now,
                messages: messages.map((message) => ({ ...message })),
                lastRetrieved: lastRetrieved.map((result) => ({ ...result })),
            };
            const withoutCurrent = prev.filter((session) => session.id !== activeSessionId);
            const updated = [nextSession, ...withoutCurrent]
                .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
                .slice(0, MAX_STORED_CHAT_SESSIONS);
            persistChatHistory(updated);
            return updated;
        });
    }, [activeSessionId, lastRetrieved, messages]);

    useEffect(() => {
        let mounted = true;

        (async () => {
            setStarting(true);
            setLastError(null);
            try {
                await window.llama.start();
                await window.api.embedder.start();
                const st: LlamaStatus = await window.llama.status();
                if (!mounted) return;
                setChatModelStatus(st);
            } catch (e: any) {
                if (!mounted) return;
                setLastError(String(e?.message ?? e));
                setChatModelStatus({ status: "error", port: 0, baseUrl: "", modelType: "" });
            } finally {
                if (mounted) setStarting(false);
            }
        })();

        const interval = setInterval(async () => {
            try {
                const st: LlamaStatus = await window.llama.status();
                if (mounted) setChatModelStatus(st);
            } catch {
                // ignore
            }
        }, 1500);

        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(CHAT_FOCUS_MODE_STORAGE_KEY, focusMode ? "1" : "0");
        } catch {
            // ignore localStorage issues
        }
    }, [focusMode]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const isToggleShortcut = (event.metaKey || event.ctrlKey) && event.key === "\\";
            if (isToggleShortcut) {
                event.preventDefault();
                setFocusMode((prev) => !prev);
                if (sideNavActiveItem !== "chat") {
                    setSideNavActiveItem("chat");
                }
                return;
            }
            if (event.key === "Escape" && focusMode) {
                setFocusMode(false);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [focusMode, sideNavActiveItem]);

    const stop = () => {
        try {
            window.llama.chatStreamCancel?.();
        } catch {
            // ignore
        }
        setIsGenerating(false);
    };

    const handleSelectNav = (item: NavKey) => {
        // Safety valve: never leave chat controls locked when navigating.
        if (item === "chat" && isGenerating) {
            stop();
        }
        setSideNavActiveItem(item);
    };

    const startNewChat = () => {
        if (isGenerating) stop();
        setSideNavActiveItem("chat");
        setInput("");
        setLastError(null);
        setLastRetrieved([]);
        setLastImageResults([]);
        setMessages([{ role: "system", content: DEFAULT_SYSTEM_PROMPT }]);
        setActiveSessionId(createSessionId());
    };

    const openHistorySession = (sessionId: string) => {
        const session = chatHistory.find((item) => item.id === sessionId);
        if (!session) return;
        if (isGenerating) stop();
        setActiveSessionId(session.id);
        setMessages(session.messages.length ? session.messages.map((m) => ({ ...m })) : [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }]);
        setLastRetrieved(session.lastRetrieved.map((item) => ({ ...item })));
        setLastImageResults(session.lastRetrieved.filter((item) => item.modality === "image").map((item) => ({ ...item })));
        setSideNavActiveItem("chat");
    };

    const deleteHistorySession = (sessionId: string) => {
        setChatHistory((prev) => {
            const updated = prev.filter((session) => session.id !== sessionId);
            persistChatHistory(updated);
            return updated;
        });
    };

    const clearHistory = () => {
        setChatHistory([]);
        persistChatHistory([]);
    };

    const send = async () => {
        const content = input.trim();
        if (!content || isGenerating) return;

        setLastError(null);
        setInput("");

        const userMsg: Msg = { role: "user", content };
        const history = messagesRef.current;

        setMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);

        const requestId =
            (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

        setIsGenerating(true);

        let ragResults: SearchResult[] = [];
        let augmentedContent = content;
        let directImageTextAnswer: string | null = null;

        try {
            ragResults = await window.api.rag.search(content, 5);
            ragResults = prioritizeExplicitImageFile(content, ragResults);
            ragResults = prioritizeForVisualIntent(content, ragResults);
            ragResults = await enrichImageResultsWithCaptions(ragResults);
            setLastRetrieved(ragResults);
            const imageResults = ragResults.filter((result) => result.modality === "image");
            if (imageResults.length) {
                setLastImageResults(imageResults);
            }
            directImageTextAnswer = await buildDirectImageTextAnswer(content, imageResults);
            if (directImageTextAnswer) {
                setMessages((prev) => {
                    const next = prev.slice();
                    const i = next.length - 1;
                    if (i >= 0 && next[i].role === "assistant") {
                        next[i] = { ...next[i], content: directImageTextAnswer ?? "" };
                    }
                    return next;
                });
                setIsGenerating(false);
                return;
            }
            const visualQaContext = await buildVisualQaContext(content, imageResults);
            if (visualQaContext) {
                augmentedContent = `${visualQaContext}\n\n${augmentedContent}`;
            }
            const ragPrefix = buildRagContextPrefix(ragResults);
            if (ragPrefix) augmentedContent = ragPrefix + augmentedContent;
        } catch (e) {
            console.error("RAG search failed:", e);
            setLastError(`RAG search failed: ${String((e as Error)?.message ?? e)}`);
        }

        const safeAugmentedContent = clampText(
            sanitizeForPrompt(augmentedContent),
            MAX_AUGMENTED_USER_CHARS
        );
        const augmentedUserMsg: Msg = { role: "user", content: safeAugmentedContent };
        const trimmedHistory = trimHistoryForLlama(history);
        const nextMessages = [...trimmedHistory, augmentedUserMsg];

        const totalChars = nextMessages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
        console.log("[chat] outgoing payload:", {
            messages: nextMessages.length,
            totalChars,
            ragResults: ragResults.length,
            imageResults: ragResults.filter((r) => r.modality === "image").length,
            augmentedUserChars: safeAugmentedContent.length,
        });

        const offDelta = window.llama.onChatStreamDelta?.((payload: any) => {
            if (payload?.requestId !== requestId) return;
            const delta = String(payload?.delta ?? "");
            if (!delta) return;

            setMessages((prev) => {
                const i = prev.length - 1;
                const last = prev[i];
                if (!last || last.role !== "assistant") return prev;

                const next = prev.slice();
                next[i] = { ...last, content: last.content + delta };
                return next;
            });
        });

        const safetyTimeout = setTimeout(() => {
            setIsGenerating(false);
        }, 45000);

        const cleanup = () => {
            clearTimeout(safetyTimeout);
            try { offDelta?.(); } catch { }
            try { offDone?.(); } catch { }
            try { offErr?.(); } catch { }
        };

        const offDone = window.llama.onChatStreamDone?.((payload: any) => {
            if (payload?.requestId !== requestId) return;
            setIsGenerating(false);
            cleanup();
        });

        const offErr = window.llama.onChatStreamError?.((payload: any) => {
            if (payload?.requestId !== requestId) return;
            setIsGenerating(false);
            setLastError(String(payload?.error ?? "Unknown error"));
            setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.role === "assistant" && !last.content) {
                    last.content = `⚠️ ${String(payload?.error ?? "Unknown error")}`;
                    return copy;
                }
                return [...copy, { role: "assistant", content: `⚠️ ${String(payload?.error ?? "Unknown error")}` }];
            });
            cleanup();
        });

        try {
            if (!window.llama.chatStreamStart) {
                throw new Error("Streaming API not available on window.llama");
            }
            window.llama.chatStreamStart({
                requestId,
                messages: nextMessages,
            });
        } catch (e: any) {
            setIsGenerating(false);
            setLastError(String(e?.message ?? e));
            cleanup();
        }
    };

    const buildDirectImageTextAnswer = async (
        question: string,
        imageResults: SearchResult[]
    ): Promise<string | null> => {
        const asksForText = isTextInImageQuestion(question);
        if (!asksForText) return null;
        if (!imageResults.length) {
            return "I could not find an image match for that text-extraction request in the retrieved context. Try including the exact filename (for example, `3630.FloatingFigure.png`) or re-index the folder containing the image.";
        }

        const target = pickBestImageByQuery(question, imageResults);
        if (!target) {
            return "I found image results, but could not confidently match one to your text-extraction request. Try using the exact filename.";
        }
        if (DEBUG_IMAGE_TEXT_ROUTING) {
            console.info("[image-text] selected target:", {
                question,
                fileName: target.fileName,
                documentPath: target.documentPath,
                candidateCount: imageResults.length,
            });
        }

        const ocrRaw = await window.api.rag.extractImageText(target.documentPath).catch(() => "");
        if (DEBUG_IMAGE_TEXT_ROUTING) {
            console.info("[image-text] OCR raw output:", {
                fileName: target.fileName,
                rawLength: ocrRaw.length,
                rawPreview: ocrRaw.slice(0, 200),
            });
        }
        const ocr = normalizeOcrText(ocrRaw);
        if (ocr) {
            return `I found text in \`${target.fileName}\`:\n\n${ocr}`;
        }
        return `I could not detect reliable readable text in \`${target.fileName}\` with the current local OCR model. Try a clearer/higher-resolution image or tighter crop around the text.`;
    };

    const enrichImageResultsWithCaptions = async (results: SearchResult[]): Promise<SearchResult[]> => {
        const imageTargets = results
            .filter((result) => result.modality === "image")
            .slice(0, MAX_IMAGE_CAPTIONS_PER_QUERY);

        if (!imageTargets.length) return results;

        const descriptionByPath = new Map<string, string>();
        // Run sequentially: the captioner pipeline loads on first call and is heavy.
        // Concurrent first-time calls used to race the model load and double memory pressure.
        for (const imageResult of imageTargets) {
            try {
                const caption = await window.api.rag.describeImage(imageResult.documentPath);
                if (caption?.trim()) {
                    descriptionByPath.set(imageResult.documentPath, caption.trim());
                }
            } catch (error) {
                console.warn("Image caption failed for:", imageResult.documentPath, error);
            }
        }

        if (!descriptionByPath.size) return results;

        return results.map((result) => {
            const caption = descriptionByPath.get(result.documentPath);
            if (!caption) return result;

            return {
                ...result,
                content: `[image] ${result.fileName}\nCaption: ${caption}`,
            };
        });
    };

    const buildVisualQaContext = async (
        question: string,
        imageResults: SearchResult[]
    ): Promise<string> => {
        if (!isVisualQuestion(question)) return "";

        const candidates = imageResults.length
            ? imageResults
            : lastImageResults;
        if (!candidates.length) return "";

        const targets = candidates.slice(0, MAX_VISUAL_QA_IMAGES);
        // Run sequentially: VQA pipeline is also a heavy ONNX session that loads on first call.
        // Concurrent first-time calls would race the model init and waste memory.
        const answers: Array<{ fileName: string; documentPath: string; answer: string } | null> = [];
        for (const target of targets) {
            try {
                const answer = await window.api.rag.answerImageQuestion(target.documentPath, question);
                answers.push({
                    fileName: target.fileName,
                    documentPath: target.documentPath,
                    answer,
                });
            } catch (error) {
                console.warn("Visual QA failed for:", target.documentPath, error);
                answers.push(null);
            }
        }

        const successful = answers.filter(Boolean) as Array<{
            fileName: string;
            documentPath: string;
            answer: string;
        }>;
        if (!successful.length) return "";

        const lines = successful.map((item, index) => {
            const safeAnswer = clampText(sanitizeForPrompt(item.answer ?? ""), 400);
            return `Visual QA ${index + 1}: ${item.fileName}\nPath: ${item.documentPath}\nAnswer: ${safeAnswer}`;
        });
        const body = clampText(lines.join("\n\n"), MAX_VISUAL_QA_CONTEXT_CHARS);
        return `Use these visual QA answers as primary evidence for image-specific details.\n\n${body}`;
    };

    const buildRagContextPrefix = (results: SearchResult[]): string => {
        return packForChatPrefix(results, {
            maxCharsPerItem: MAX_CHARS_PER_RAG_RESULT,
            maxTotalChars: MAX_RAG_PREFIX_CHARS,
        });
    };

    // Navigate to chat and optionally pre-fill the input
    const navigateToChat = (query?: string) => {
        if (isGenerating) stop();
        setSideNavActiveItem('chat');
        if (query) setInput(query);
    };

    const renderCanvasContent = () => {
        switch (sideNavActiveItem) {
            case 'home':
                return <HomeScreen onNavigateToChat={navigateToChat} />;

            case 'vault':
                return <VaultAppsScreen />;

            case 'history':
                return (
                    <HistoryScreen
                        sessions={chatHistory}
                        activeSessionId={activeSessionId}
                        onOpenSession={openHistorySession}
                        onDeleteSession={deleteHistorySession}
                        onClearAll={clearHistory}
                    />
                );

            case 'settings':
                return (
                    <SettingsScreen
                        selectedTheme={selectedTheme}
                        onToggleTheme={onToggleTheme}
                    />
                );

            case 'about':
                return <PrivacyAboutScreen />;

            default:
                return null;
        }
    };

    const renderScreen = () => {
        if (sideNavActiveItem === 'chat') {
            return (
                <ChatScreen
                    starting={starting}
                    messages={messages}
                    input={input}
                    setInput={setInput}
                    send={send}
                    stop={stop}
                    isGenerating={isGenerating}
                    lastError={lastError}
                    lastRetrieved={lastRetrieved}
                    onNavigateToChat={navigateToChat}
                    focusMode={focusMode}
                    onToggleFocusMode={() => setFocusMode((prev) => !prev)}
                />
            );
        }

        if (sideNavActiveItem === 'files') {
            return <FilesScreen onNavigateToChat={navigateToChat} />;
        }

        return (
            <MainCanvas
                contentMaxWidth="100%"
                canvasContent={renderCanvasContent()}
            />
        );
    };

    const renderMainContent = () => {
        const isHome = sideNavActiveItem === 'home';
        const showFocusToggle = sideNavActiveItem === "chat";
        const hideTopBar = isHome || (sideNavActiveItem === "chat" && focusMode);
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {/* Global top bar — hidden on home screen */}
                {!hideTopBar && (
                    <Box
                        sx={(theme) => ({
                            height: 56,
                            flexShrink: 0,
                            display: 'flex',
                            alignItems: 'center',
                            px: 4,
                            borderBottom: `1px solid ${theme.palette.outline.variant}`,
                            backdropFilter: 'blur(12px)',
                        })}
                    >
                        <Box sx={{ display: "flex", alignItems: "center", width: "100%", gap: 1.25 }}>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                                <ChatThreadTopBar
                                    starting={starting}
                                    chatModelStatus={chatModelStatus}
                                    homeLabel="Home"
                                    sessionLabel={NAV_LABELS[sideNavActiveItem]}
                                    statusLabel={chatModelStatus?.status ?? 'unknown'}
                                    onHomeClick={() => setSideNavActiveItem('home')}
                                />
                            </Box>
                            {showFocusToggle && (
                                <Button
                                    size="small"
                                    variant={focusMode ? "contained" : "outlined"}
                                    startIcon={<Icon sx={{ fontSize: 16 }}>fullscreen</Icon>}
                                    onClick={() => setFocusMode((prev) => !prev)}
                                    sx={{ textTransform: "none", whiteSpace: "nowrap" }}
                                >
                                    Focus
                                </Button>
                            )}
                        </Box>
                    </Box>
                )}
                {renderScreen()}
            </Box>
        );
    };

    return (
        <AppShell
            sideBar={
                <SidebarNav
                    activeItem={sideNavActiveItem}
                    onSelect={handleSelectNav}
                    onNewChat={startNewChat}
                    selectedTheme={selectedTheme}
                    onThemeChange={onToggleTheme}
                />
            }
            mainCanvas={renderMainContent()}
            hideSidebar={focusMode && sideNavActiveItem === "chat"}
        />
    );
}

export default App;

function createSessionId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function deriveSessionTitle(messages: Msg[]): string {
    const firstUserMessage = messages.find((message) => message.role === "user" && message.content?.trim());
    if (!firstUserMessage) return "Untitled chat";
    return clampText(firstUserMessage.content.trim().replace(/\s+/g, " "), 70);
}

function loadChatHistory(): ChatSession[] {
    try {
        const raw = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as ChatSession[];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item) => item && typeof item.id === "string" && Array.isArray(item.messages))
            .map((item) => ({
                id: item.id,
                title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled chat",
                createdAtMs: Number(item.createdAtMs ?? Date.now()),
                updatedAtMs: Number(item.updatedAtMs ?? Date.now()),
                messages: item.messages,
                lastRetrieved: Array.isArray(item.lastRetrieved) ? item.lastRetrieved : [],
            }))
            .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
            .slice(0, MAX_STORED_CHAT_SESSIONS);
    } catch {
        return [];
    }
}

function persistChatHistory(sessions: ChatSession[]) {
    try {
        localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(sessions));
    } catch {
        // ignore localStorage errors (quota/private mode)
    }
}

function sanitizeForPrompt(text: string): string {
    if (!text) return "";
    // Strip control chars except \n and \t; collapse runs of whitespace; trim.
    return text
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function clampText(text: string, max: number): string {
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + "…";
}

function trimHistoryForLlama(history: Msg[]): Msg[] {
    if (history.length <= 1) return history;
    const [system, ...rest] = history;
    const recent = rest
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        // drop any empty assistant placeholders left over from canceled streams
        .filter((m) => !(m.role === "assistant" && !m.content.trim()));
    const tail = recent.slice(-MAX_HISTORY_MESSAGES);
    return system ? [system, ...tail] : tail;
}

function isVisualQuestion(question: string): boolean {
    const normalized = question.toLowerCase();
    return [
        "image",
        "photo",
        "picture",
        "color",
        "colour",
        "what is",
        "what's",
        "can you see",
        "describe",
        "object",
        "dog",
        "cat",
        "apple",
        "person",
        "in this",
    ].some((token) => normalized.includes(token));
}

function prioritizeExplicitImageFile(query: string, results: SearchResult[]): SearchResult[] {
    const lowerQuery = query.toLowerCase();
    const explicitName = getExplicitImageFilename(query)?.toLowerCase();
    const asksForImageText = isTextInImageQuestion(lowerQuery);
    const imageResults = results.filter((result) => result.modality === "image");
    const likelyImageReference = isLikelyImageReferenceQuery(query, imageResults);
    if (!explicitName && !asksForImageText && !likelyImageReference) return results;
    if (!imageResults.length) return results;

    const best = pickBestImageByQuery(query, imageResults);
    if (!best) return results;
    const exact = [best];
    if (!asksForImageText) return [...exact, ...results.filter((r) => r.documentPath !== best.documentPath)];

    // For OCR-style questions, keep only the best-matching image to avoid context pollution.
    return exact;
}

function prioritizeForVisualIntent(query: string, results: SearchResult[]): SearchResult[] {
    if (!isVisualQuestion(query)) return results;
    const imageResults = results.filter((result) => result.modality === "image");
    if (!imageResults.length) return results;
    // For image-centric prompts, keep context image-first and avoid text-file pollution.
    return imageResults;
}

function normalizeOcrText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length < MIN_OCR_TEXT_LEN) return "";
    if (/^[A-Z0-9]{1,3}$/.test(normalized)) return "";
    return normalized;
}

function getExplicitImageFilename(query: string): string | null {
    return query.match(/([A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))/i)?.[1] ?? null;
}

function isTextInImageQuestion(text: string): boolean {
    return /text|ocr|read|word|sentence|letters|written/.test(text.toLowerCase());
}

function normalizeForFilenameMatch(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isLikelyImageReferenceQuery(query: string, imageResults: SearchResult[]): boolean {
    if (!imageResults.length) return false;
    const hasNumericAnchor = /\b\d{2,}\b/.test(query);
    const normalizedQuery = normalizeForFilenameMatch(query);
    if (!normalizedQuery) return false;
    if (hasNumericAnchor) return true;

    return imageResults.some((result) => {
        const base = result.fileName.replace(/\.[^.]+$/, "");
        const normalizedBase = normalizeForFilenameMatch(base);
        return (
            normalizedBase.length >= 6 &&
            (normalizedQuery.includes(normalizedBase) || normalizedBase.includes(normalizedQuery))
        );
    });
}

function pickBestImageByQuery(query: string, imageResults: SearchResult[]): SearchResult | null {
    if (!imageResults.length) return null;

    const explicitName = getExplicitImageFilename(query);
    if (explicitName) {
        const explicitNormalized = normalizeForFilenameMatch(explicitName);
        const exact = imageResults.find(
            (result) => normalizeForFilenameMatch(result.fileName) === explicitNormalized
        );
        if (exact) return exact;
    }

    const queryNormalized = normalizeForFilenameMatch(query);
    const scored = imageResults
        .map((result) => {
            const base = result.fileName.replace(/\.[^.]+$/, "");
            const candidate = normalizeForFilenameMatch(base);
            const starts = queryNormalized.includes(candidate) || candidate.includes(queryNormalized);
            const overlap = candidate
                .split(/(?=[0-9])|(?<=[0-9])/)
                .filter(Boolean)
                .reduce((count, token) => count + (queryNormalized.includes(token) ? 1 : 0), 0);
            const score = (starts ? 1000 : 0) + overlap + (candidate.length > 0 && queryNormalized.includes(candidate) ? 50 : 0);
            return { result, score };
        })
        .sort((a, b) => b.score - a.score);

    return scored[0]?.score > 0 ? scored[0].result : imageResults[0];
}
