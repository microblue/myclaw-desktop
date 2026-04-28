import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, RefreshCw, KeyRound, Plus, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface OpenClawStatusSnapshot {
  runtime: {
    ready: boolean;
    version: string | null;
    dir: string;
    installMarkerExists: boolean;
    needsInstall: boolean;
  };
  config: {
    exists: boolean;
    path: string;
    providerCount: number;
    defaultProviderKey: string | null;
    channelTypes: string[];
    agentCount: number;
  };
  plugins: {
    installed: string[];
    enabled: string[];
  };
}

interface AuthLogEntry {
  line: string;
  stream: 'stdout' | 'stderr';
}

interface DoctorResult {
  success: boolean;
  exitCode: number | null;
  error?: string;
}

interface AuthResult {
  success: boolean;
  exitCode: number | null;
  error?: string;
}

const ipcOn = (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
  type ElectronShape = { on?: (c: string, cb: (...a: unknown[]) => void) => () => void };
  const electron = (window as unknown as { electron?: ElectronShape }).electron;
  if (electron?.on) return electron.on(channel, cb);
  return () => { /* no-op for environments without preload (e.g. browser dev) */ };
};

function StatusRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[14px]">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />
      ) : (
        <XCircle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
      )}
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
    </div>
  );
}

export function MyClawStatusPanel() {
  const { t } = useTranslation('settings');
  const [snapshot, setSnapshot] = useState<OpenClawStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [reLoggingIn, setReLoggingIn] = useState(false);
  const [authLog, setAuthLog] = useState<AuthLogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invokeIpc<OpenClawStatusSnapshot>('openclaw:statusSnapshot');
      setSnapshot(next);
    } catch (err) {
      console.error('openclaw:statusSnapshot failed', err);
      toast.error(t('status.refreshError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Stream subprocess logs into the panel.
  useEffect(() => {
    return ipcOn('openclaw:auth-log', (...args: unknown[]) => {
      const payload = args[0] as AuthLogEntry | undefined;
      if (!payload?.line) return;
      setAuthLog((prev) => {
        const next = [...prev, payload];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [authLog]);

  const handleFix = async () => {
    if (fixing) return;
    setFixing(true);
    try {
      const result = await invokeIpc<DoctorResult>('developer:runDoctor', { mode: 'fix' });
      if (result.success) {
        toast.success(t('status.fixSuccess'));
        await refresh();
      } else {
        toast.error(t('status.fixFailed', { error: result.error || `exit ${result.exitCode}` }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('status.fixFailed', { error: message }));
    } finally {
      setFixing(false);
    }
  };

  const handleReLogin = async () => {
    if (reLoggingIn) return;
    const provider = snapshot?.config.defaultProviderKey;
    if (!provider) {
      toast.error(t('status.loginNoProvider'));
      return;
    }
    setReLoggingIn(true);
    setAuthLog([]);
    try {
      const result = await invokeIpc<AuthResult>('openclaw:authLogin', { provider, setDefault: true });
      if (result.success) {
        toast.success(t('status.loginSuccess'));
        await refresh();
      } else {
        toast.error(t('status.loginFailed', { error: result.error || `exit ${result.exitCode}` }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('status.loginFailed', { error: message }));
    } finally {
      setReLoggingIn(false);
    }
  };

  if (loading) {
    return (
      <div data-testid="settings-status-panel" className="text-[14px] text-muted-foreground">
        {t('status.loading')}
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div data-testid="settings-status-panel" className="text-[14px] text-muted-foreground">
        {t('status.refreshError')}
      </div>
    );
  }

  const runtimeLabel = snapshot.runtime.ready
    ? snapshot.runtime.version
      ? t('status.runtimeReady', { version: snapshot.runtime.version })
      : t('status.runtimeUnknown')
    : t('status.runtimeNotReady');

  const providerLabel = t('status.providerCount', { count: snapshot.config.providerCount });
  const channelLabel = t('status.channelCount', { count: snapshot.config.channelTypes.length });

  return (
    <div data-testid="settings-status-panel" className="space-y-6">
      <div>
        <h2
          className="text-3xl font-serif text-foreground mb-2 font-normal tracking-tight"
          style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
        >
          {t('status.title')}
        </h2>
        <p className="text-[13px] text-muted-foreground">{t('status.subtitle')}</p>
      </div>

      <div className="space-y-3 rounded-2xl bg-black/5 dark:bg-white/5 p-5 border border-black/5 dark:border-white/5">
        <StatusRow ok={snapshot.runtime.ready} label={runtimeLabel} />
        <StatusRow ok={snapshot.config.providerCount > 0} label={providerLabel} />
        {snapshot.config.defaultProviderKey ? (
          <div className="text-[12px] text-muted-foreground pl-6">
            {t('status.defaultProvider', { name: snapshot.config.defaultProviderKey })}
          </div>
        ) : null}
        <StatusRow ok={snapshot.config.channelTypes.length > 0} label={channelLabel} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleFix}
          disabled={fixing}
          data-testid="status-fix-runtime"
          className="rounded-full h-9 px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', fixing && 'animate-spin')} />
          {fixing ? t('status.fixRuntimeRunning') : t('status.fixRuntime')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReLogin}
          disabled={reLoggingIn || !snapshot.config.defaultProviderKey}
          data-testid="status-relogin"
          className="rounded-full h-9 px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
        >
          <KeyRound className={cn('h-3.5 w-3.5 mr-1.5', reLoggingIn && 'animate-pulse')} />
          {reLoggingIn ? t('status.reLoginRunning') : t('status.reLogin')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { window.location.hash = '#provider-accounts'; }}
          className="rounded-full h-9 px-4 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          {t('status.addProvider')}
        </Button>
      </div>

      {authLog.length > 0 && (
        <div className="rounded-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="font-medium text-[13px]">{t('status.logsTitle')}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAuthLog([])}
              className="h-7 text-[12px] rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              {t('status.logsClear')}
            </Button>
          </div>
          <pre
            data-testid="status-log-output"
            className="text-[12px] text-muted-foreground bg-white dark:bg-card p-3 rounded-xl max-h-48 overflow-auto whitespace-pre-wrap font-mono border border-black/5 dark:border-white/5"
          >
            {authLog.map((entry, i) => (
              <span key={i} className={entry.stream === 'stderr' ? 'text-amber-600 dark:text-amber-500' : ''}>
                {entry.line}
              </span>
            ))}
            <div ref={logEndRef} />
          </pre>
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        data-testid="status-advanced-toggle"
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown
          className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')}
        />
        {t('status.advancedToggle')}
      </button>

      {advancedOpen && (
        <div data-testid="status-advanced-section" className="space-y-3 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] p-5 border border-black/5 dark:border-white/5 text-[12px] font-mono">
          <DiagnosticRow label={t('status.advancedRuntimeDir')} value={snapshot.runtime.dir} />
          <DiagnosticRow label={t('status.advancedConfigPath')} value={snapshot.config.path} />
          <DiagnosticRow
            label={t('status.advancedInstallMarker')}
            value={
              snapshot.runtime.installMarkerExists
                ? t('status.advancedInstallMarkerPresent')
                : t('status.advancedInstallMarkerMissing')
            }
          />
          <Separator className="bg-black/5 dark:bg-white/5" />
          <div>
            <div className="text-muted-foreground mb-1.5">
              {t('status.advancedInstalledPlugins', { count: snapshot.plugins.installed.length })}
            </div>
            <div className="text-foreground/80">
              {snapshot.plugins.installed.length === 0
                ? t('status.advancedNoPlugins')
                : snapshot.plugins.installed.join(', ')}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground mb-1.5">{t('status.advancedEnabledPlugins')}</div>
            <div className="text-foreground/80">
              {snapshot.plugins.enabled.length === 0
                ? t('status.advancedNoPlugins')
                : snapshot.plugins.enabled.join(', ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="text-foreground/80 break-all">{value}</div>
    </div>
  );
}
