import { Box, Button, CircularProgress, Icon, IconButton, Tooltip, Typography } from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import { useState } from "react";

type FileWatcherPickerProps = {
    onIndexingUpdated?: () => void;
};

function FileWatcherPicker({ onIndexingUpdated }: FileWatcherPickerProps) {
    const theme = useTheme();
    const [watchedPaths, setWatchedPaths] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [maintenanceLoading, setMaintenanceLoading] = useState<null | "clear" | "reindex">(null);
    const [error, setError] = useState<string | null>(null);
    const [fileIndexSummary, setFileIndexSummary] = useState<string | null>(null);
    const [fileIndexDetails, setFileIndexDetails] = useState<Array<{ path: string; skipped: boolean; reason?: string }>>([]);
    const [stats, setStats] = useState<{
        scanned: number;
        indexed: number;
        skipped: number;
        textIndexed: number;
        codeIndexed: number;
        imageIndexed: number;
        lastIndexedAtMs: number | null;
    } | null>(null);

    async function handlePick(addToExisting = false) {
        setLoading(true);
        setError(null);
        setFileIndexSummary(null);
        setFileIndexDetails([]);
        try {
            const result = await window.watcher.pickDirectory({ includeCodeFiles: false, indexAllFiles: false }, addToExisting);
            if (!result.canceled && result.path) {
                setWatchedPaths(result.rootPaths ?? (result.rootPath ? [result.rootPath] : []));
                setStats(result.indexingStats);
                onIndexingUpdated?.();
                setLoading(false);
            } else {
                setError("Failed to open directory. Please try again.");
                setLoading(false);
            }
        } catch {
            setError("An unexpected error occurred.");
            setLoading(false);
        }
    }

    async function handleClearIndex() {
        setMaintenanceLoading("clear");
        setError(null);
        setFileIndexSummary(null);
        setFileIndexDetails([]);
        try {
            const result = await window.watcher.clearIndex();
            setStats(result.indexingStats);
            onIndexingUpdated?.();
            if (!result.rootPath) {
                setWatchedPaths([]);
            }
        } catch {
            setError("Failed to clear index.");
        } finally {
            setMaintenanceLoading(null);
        }
    }

    async function handleReindex() {
        setMaintenanceLoading("reindex");
        setError(null);
        setFileIndexSummary(null);
        setFileIndexDetails([]);
        try {
            const result = await window.watcher.reindex();
            if (result.warning === "no_root_path") {
                setError("Pick a folder first, then reindex.");
            }
            setWatchedPaths(result.rootPaths ?? (result.rootPath ? [result.rootPath] : []));
            setStats(result.indexingStats);
            onIndexingUpdated?.();
        } catch {
            setError("Reindex failed. Check logs and try again.");
        } finally {
            setMaintenanceLoading(null);
        }
    }

    const handleCancel = () => {
        setWatchedPaths([]);
        setLoading(false);
        setError(null);
        setFileIndexSummary(null);
        setFileIndexDetails([]);
    };

    async function handlePickFiles() {
        setLoading(true);
        setError(null);
        setFileIndexSummary(null);
        setFileIndexDetails([]);
        try {
            const result = await window.watcher.pickFiles();
            setStats(result.indexingStats);
            if (!result.canceled) {
                setFileIndexSummary(
                    `Indexed ${result.indexedCount} file${result.indexedCount !== 1 ? "s" : ""}` +
                    (result.skippedCount ? ` · Skipped ${result.skippedCount}` : "")
                );
                setFileIndexDetails(result.details ?? []);
                onIndexingUpdated?.();
            }
        } catch {
            setError("Failed to index selected files.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <Box>
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.5 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                    <Icon sx={{ fontSize: 16, color: theme.palette.primary.main }}>folder_open</Icon>
                    <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: theme.palette.text.primary }}>
                        Choose a folder to watch
                    </Typography>
                </Box>
                <Tooltip title="Reset">
                    <IconButton size="small" onClick={handleCancel} sx={{ p: 0.5 }}>
                        <Icon sx={{ fontSize: 16, color: theme.palette.text.secondary }}>close</Icon>
                    </IconButton>
                </Tooltip>
            </Box>

            {error && (
                <Box
                    sx={{
                        mb: 1.5,
                        px: 1.5,
                        py: 1,
                        borderRadius: 1,
                        backgroundColor: alpha(theme.palette.error.main, 0.08),
                        border: `1px solid ${alpha(theme.palette.error.main, 0.2)}`,
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 0.75,
                    }}
                >
                    <Icon sx={{ fontSize: 15, color: theme.palette.error.main, mt: 0.15, flexShrink: 0 }}>warning</Icon>
                    <Typography sx={{ fontSize: '0.78rem', color: theme.palette.error.main }}>
                        {error}
                    </Typography>
                </Box>
            )}

            <Button
                variant={loading ? "outlined" : "contained"}
                startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <Icon>folder</Icon>}
                onClick={handlePick}
                disabled={loading || maintenanceLoading !== null}
                sx={{ mb: 1.25, fontSize: '0.8rem' }}
            >
                {loading ? "Indexing…" : "Choose folder"}
            </Button>
            <Button
                variant="outlined"
                startIcon={<Icon>create_new_folder</Icon>}
                onClick={() => handlePick(true)}
                disabled={loading || maintenanceLoading !== null}
                sx={{ mb: 1.25, ml: 1, fontSize: "0.8rem" }}
            >
                Add folder
            </Button>
            <Button
                variant="outlined"
                startIcon={<Icon>upload_file</Icon>}
                onClick={handlePickFiles}
                disabled={loading || maintenanceLoading !== null}
                sx={{ mb: 1.25, ml: 1, fontSize: "0.8rem" }}
            >
                Choose files
            </Button>

            <Box sx={{ display: "flex", gap: 1, mb: 1.25, flexWrap: "wrap" }}>
                <Button
                    variant="outlined"
                    color="warning"
                    startIcon={maintenanceLoading === "clear" ? <CircularProgress size={14} color="inherit" /> : <Icon>delete_sweep</Icon>}
                    onClick={handleClearIndex}
                    disabled={loading || maintenanceLoading !== null}
                    sx={{ fontSize: "0.75rem" }}
                >
                    {maintenanceLoading === "clear" ? "Clearing…" : "Clear index"}
                </Button>
                <Button
                    variant="outlined"
                    startIcon={maintenanceLoading === "reindex" ? <CircularProgress size={14} color="inherit" /> : <Icon>refresh</Icon>}
                    onClick={handleReindex}
                    disabled={loading || maintenanceLoading !== null}
                    sx={{ fontSize: "0.75rem" }}
                >
                    {maintenanceLoading === "reindex" ? "Reindexing…" : "Clear + reindex"}
                </Button>
            </Box>

            <Typography sx={{ fontSize: '0.76rem', color: theme.palette.text.secondary, mb: 0.5 }}>
                Using default safe indexing rules (code files off, skip filtering on).
            </Typography>

            {fileIndexSummary && (
                <Typography sx={{ fontSize: '0.74rem', color: theme.palette.text.secondary, mb: 0.5 }}>
                    {fileIndexSummary}
                </Typography>
            )}
            {fileIndexDetails.length > 0 && (
                <Box sx={{ mb: 1, display: "flex", flexDirection: "column", gap: 0.25 }}>
                    {fileIndexDetails.map((item) => (
                        <Typography
                            key={`${item.path}-${item.reason ?? "ok"}`}
                            sx={{
                                fontSize: "0.7rem",
                                color: item.skipped ? theme.palette.warning.main : theme.palette.text.secondary,
                            }}
                        >
                            {item.skipped ? "Skipped" : "Indexed"}: {basename(item.path)}
                            {item.skipped && item.reason ? ` (${item.reason})` : ""}
                        </Typography>
                    ))}
                </Box>
            )}

            {watchedPaths.length > 0 && (
                <Box
                    sx={{
                        mt: 1.5,
                        p: 1.5,
                        borderRadius: 1.5,
                        backgroundColor: alpha(theme.palette.primary.main, 0.06),
                        border: `1px solid ${alpha(theme.palette.primary.main, 0.18)}`,
                    }}
                >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
                        <Icon sx={{ fontSize: 14, color: '#4CAF50', flexShrink: 0 }}>check_circle</Icon>
                        <Typography
                            sx={{
                                fontSize: '0.78rem',
                                color: theme.palette.text.primary,
                                fontWeight: 600,
                            }}
                        >
                            Watching {watchedPaths.length} folder{watchedPaths.length !== 1 ? "s" : ""}
                        </Typography>
                    </Box>
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.35, mb: stats ? 0.75 : 0 }}>
                        {watchedPaths.map((p) => (
                            <Typography
                                key={p}
                                sx={{
                                    fontSize: '0.72rem',
                                    color: theme.palette.text.secondary,
                                    wordBreak: 'break-all',
                                }}
                            >
                                {p}
                            </Typography>
                        ))}
                    </Box>
                    {stats && (
                        <Typography sx={{ fontSize: '0.72rem', color: theme.palette.text.secondary, lineHeight: 1.6 }}>
                            {stats.indexed} indexed · {stats.textIndexed} text · {stats.codeIndexed} code · {stats.imageIndexed} images · {stats.skipped} skipped
                            {stats.lastIndexedAtMs ? ` · ${new Date(stats.lastIndexedAtMs).toLocaleTimeString()}` : ""}
                        </Typography>
                    )}
                </Box>
            )}
        </Box>
    );
}

export default FileWatcherPicker;

function basename(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || filePath;
}
