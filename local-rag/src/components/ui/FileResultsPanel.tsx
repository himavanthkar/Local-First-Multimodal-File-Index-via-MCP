import { useState } from "react";
import { Box, Button, Icon, IconButton, Tooltip, Typography } from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import type { SearchResult } from "../../types/global";
import FileResultCard from "./FileResultCard";
import { packContext } from "../../utils/contextPacker";

type FileResultsPanelProps = {
    results: SearchResult[];
    selectedId?: number | null;
    onSelect: (result: SearchResult) => void;
    onAskObi: (query: string) => void;
    onClose?: () => void;
};

const TOP_N = 3;

export default function FileResultsPanel({
    results,
    selectedId,
    onSelect,
    onAskObi,
    onClose,
}: FileResultsPanelProps) {
    const theme = useTheme();
    const [showAll, setShowAll] = useState(false);
    const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

    const displayed = showAll ? results : results.slice(0, TOP_N);
    const hiddenCount = results.length - TOP_N;

    const handleCopyContext = async () => {
        if (!results.length) return;
        const { markdown } = packContext(results, {
            maxCharsPerItem: 1200,
            maxTotalChars: 12000,
        });
        if (!markdown) return;
        try {
            await navigator.clipboard.writeText(markdown);
            setCopyState("copied");
        } catch {
            setCopyState("error");
        }
        setTimeout(() => setCopyState("idle"), 1500);
    };

    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                backgroundColor: theme.palette.surface.low,
            }}
        >
            {/* Header */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    px: 2,
                    py: 1.5,
                    borderBottom: `1px solid ${theme.palette.outline.variant}`,
                    flexShrink: 0,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Icon sx={{ fontSize: 15, color: theme.palette.primary.main }}>library_books</Icon>
                    <Typography
                        sx={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.1em',
                            color: theme.palette.text.secondary,
                        }}
                    >
                        Top Sources
                    </Typography>
                    <Box
                        sx={{
                            px: 0.75,
                            py: 0.1,
                            borderRadius: 0.75,
                            backgroundColor: theme.palette.primary.main,
                            color: theme.palette.primary.contrastText,
                            fontSize: '0.58rem',
                            fontWeight: 700,
                            lineHeight: 1.6,
                        }}
                    >
                        {results.length}
                    </Box>
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                    <Tooltip
                        title={
                            copyState === "copied"
                                ? "Copied! Paste into Cursor or any agent."
                                : copyState === "error"
                                    ? "Clipboard unavailable"
                                    : "Copy as Cursor context"
                        }
                    >
                        <span>
                            <IconButton
                                size="small"
                                onClick={handleCopyContext}
                                disabled={!results.length}
                                sx={{ p: 0.5 }}
                            >
                                <Icon sx={{ fontSize: 16 }}>
                                    {copyState === "copied" ? "check" : "content_copy"}
                                </Icon>
                            </IconButton>
                        </span>
                    </Tooltip>
                    {onClose && (
                        <IconButton size="small" onClick={onClose} sx={{ p: 0.5 }}>
                            <Icon sx={{ fontSize: 16 }}>close</Icon>
                        </IconButton>
                    )}
                </Box>
            </Box>

            {/* File list */}
            <Box
                sx={{
                    flex: 1,
                    overflowY: 'auto',
                    p: 1.5,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.75,
                }}
            >
                {displayed.map((r, i) => (
                    <FileResultCard
                        key={r.chunkId}
                        result={r}
                        rank={i + 1}
                        compact
                        selected={selectedId === r.chunkId}
                        onClick={() => onSelect(r)}
                        onAskObi={onAskObi}
                    />
                ))}

                {!showAll && hiddenCount > 0 && (
                    <Button
                        size="small"
                        variant="text"
                        onClick={() => setShowAll(true)}
                        startIcon={<Icon sx={{ fontSize: 14 }}>expand_more</Icon>}
                        sx={{
                            fontSize: '0.72rem',
                            color: theme.palette.primary.main,
                            justifyContent: 'flex-start',
                            px: 1.5,
                            py: 0.75,
                            borderRadius: 1.5,
                            border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
                            backgroundColor: alpha(theme.palette.primary.main, 0.04),
                            '&:hover': {
                                backgroundColor: alpha(theme.palette.primary.main, 0.08),
                            },
                        }}
                    >
                        Show {hiddenCount} more source{hiddenCount !== 1 ? 's' : ''}
                    </Button>
                )}

                {showAll && hiddenCount > 0 && (
                    <Button
                        size="small"
                        variant="text"
                        onClick={() => setShowAll(false)}
                        startIcon={<Icon sx={{ fontSize: 14 }}>expand_less</Icon>}
                        sx={{
                            fontSize: '0.72rem',
                            color: theme.palette.text.secondary,
                            justifyContent: 'flex-start',
                            px: 1.5,
                            py: 0.75,
                        }}
                    >
                        Show less
                    </Button>
                )}
            </Box>

            <Box
                sx={{
                    px: 2,
                    py: 1,
                    borderTop: `1px solid ${theme.palette.outline.variant}`,
                    flexShrink: 0,
                }}
            >
                <Typography
                    sx={{
                        fontSize: '0.62rem',
                        color: theme.palette.text.disabled,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        textAlign: 'center',
                    }}
                >
                    Click a source to preview
                </Typography>
            </Box>
        </Box>
    );
}
