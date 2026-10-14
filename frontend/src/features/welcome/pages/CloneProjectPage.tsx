/**
 * CloneProjectPage - Clone an existing repository from GitHub.
 *
 * Two input modes:
 *  1. **Browse** — authenticate with GitHub, search/select from your repos (personal + org).
 *  2. **Manual URL** — paste an HTTPS or SSH clone URL directly.
 *
 * Destination folder is chosen via native folder picker.
 * On success the cloned repo is automatically opened.
 */
import {
  memo,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type CSSProperties,
} from 'react';
import {
  Download,
  Github,
  FolderOpen,
  Check,
  Loader2,
  AlertTriangle,
  AlertCircle,
  Search,
  Lock,
  Globe,
  Star,
  GitFork,
} from 'lucide-react';
import { ICON_SIZES } from '../../../shared/constants';
import { ICON_STYLES } from '../../../shared/utils/gitHelpers';
import { useRepo } from '../../../context';
import GitHubDeviceFlowModal from '../../auth/components/GitHubDeviceFlowModal';
import { useGitHubDeviceFlow } from '../../auth/hooks/useGitHubDeviceFlow';
import ProjectCreationStepper, { type StepperStatus } from '../components/ProjectCreationStepper';
import { Button, Input, Select, Switch } from '../../../shared/ui';
import type { SelectOption } from '../../../shared/ui';
import { OpenFolderDialog } from '../../../../bindings/iofabrik/services/filedialogservice';
import { RepoList, RepoListForOrg, RepoClone } from '../../../../bindings/iofabrik/services/githubservice';
import type { GitHubRepo } from '../../../../bindings/iofabrik/services/models';

// ============================================================================
// Types
// ============================================================================

/** Tracks which input mode the user is using. */
type InputMode = 'browse' | 'url';

/** A repo entry enriched with its display group (owner). */
interface GroupedRepo {
  repo: GitHubRepo;
  owner: string;
}

// ============================================================================
// Constants
// ============================================================================


const REPO_FETCH_LIMIT = 100;

/** Matches `https://github.com/owner/repo` or `git@github.com:owner/repo.git` */
const GIT_URL_RE =
  /^(?:https?:\/\/[^/]+\/[^/]+\/[^/]+(?:\.git)?|git@[^:]+:[^/]+\/[^/]+(?:\.git)?)$/i;

// ============================================================================
// Sub-components
// ============================================================================

/** SectionCard — shared card wrapper (same pattern as NewProjectPage). */
function SectionCard({
  title,
  className = '',
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`bg-theme-surface border border-theme-default rounded-lg p-5 ${className}`}>
      <h3 className="text-sm font-medium text-theme-primary mb-4">{title}</h3>
      {children}
    </div>
  );
}

/** A single repo row in the search results list. */
function RepoRow({
  repo,
  isSelected,
  onSelect,
}: {
  repo: GitHubRepo;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors rounded ${
        isSelected
          ? 'bg-blue-600/20 border border-blue-500/40'
          : 'hover-bg-theme-interactive border border-transparent'
      }`}
    >
      {repo.private ? (
        <Lock size={13} className="text-yellow-400 shrink-0" />
      ) : (
        <Globe size={13} className="text-theme-muted shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <p className="text-sm text-theme-primary font-medium truncate">
          {repo.fullName}
        </p>
        {repo.description && (
          <p className="text-xs text-theme-muted truncate mt-0.5">
            {repo.description}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0 text-xs text-theme-muted">
        {repo.language && (
          <span className="hidden sm:inline">{repo.language}</span>
        )}
        {repo.stargazersCount > 0 && (
          <span className="flex items-center gap-0.5">
            <Star size={11} />
            {repo.stargazersCount}
          </span>
        )}
        {repo.forksCount > 0 && (
          <span className="flex items-center gap-0.5">
            <GitFork size={11} />
            {repo.forksCount}
          </span>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// Main component
// ============================================================================

function CloneProjectPage(): JSX.Element {
  const {
    openRepo,
    ghInstalled,
    isInstallingPackages,
    installRequiredPackages,
    ghAuthStatus,
    isCheckingGhAuth,
    loadUserOrganizations,
  } = useRepo();

  // ── Input mode ────────────────────────────────────────────────────────
  const [inputMode, setInputMode] = useState<InputMode>('browse');

  // ── GitHub auth (device flow modal) ───────────────────────────────────
  const {
    deviceFlow,
    startDeviceFlow,
    closeDeviceFlow,
    handleDeviceFlowOpenChange,
  } = useGitHubDeviceFlow({
    onStartError: (message) => setCloneError(message),
  });

  // ── Repository browsing state ─────────────────────────────────────────
  const [repos, setRepos] = useState<GroupedRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoSearchQuery, setRepoSearchQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [ownerFilter, setOwnerFilter] = useState(''); // '' = all
  const [ownerOptions, setOwnerOptions] = useState<SelectOption[]>([]);
  const [repoLoadError, setRepoLoadError] = useState<string | null>(null);
  const reposLoaded = useRef(false);

  // ── Manual URL state ──────────────────────────────────────────────────
  const [manualUrl, setManualUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);

  // ── Destination folder state ──────────────────────────────────────────
  const [destPath, setDestPath] = useState('');
  const [isBrowsingDest, setIsBrowsingDest] = useState(false);
  const [isShallowClone, setIsShallowClone] = useState(true);

  // ── Clone progress state ──────────────────────────────────────────────
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [stepperStep, setStepperStep] = useState(0);
  const [stepperStatus, setStepperStatus] = useState<StepperStatus>('idle');

  // ── Derived ───────────────────────────────────────────────────────────
  const isLoggedIn = ghAuthStatus?.loggedIn === true;
  const ghUsername = ghAuthStatus?.username ?? '';

  // Whether the clone button should be enabled
  const canClone = useMemo(() => {
    if (isCloning) return false;
    if (!destPath) return false;

    if (inputMode === 'browse') {
      return !!selectedRepo;
    }
    // url mode
    return !!manualUrl.trim() && !urlError;
  }, [isCloning, destPath, inputMode, selectedRepo, manualUrl, urlError]);

  // ── Filter repos by owner + search query ──────────────────────────────
  const filteredRepos = useMemo(() => {
    let list = repos;

    if (ownerFilter) {
      list = list.filter(r => r.owner === ownerFilter);
    }

    const q = repoSearchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        r =>
          r.repo.fullName.toLowerCase().includes(q) ||
          (r.repo.description && r.repo.description.toLowerCase().includes(q)),
      );
    }

    return list;
  }, [repos, ownerFilter, repoSearchQuery]);

  // ── Load repos + orgs once after login ────────────────────────────────

  const loadReposAndOrgs = useCallback(async () => {
    if (!isLoggedIn) return;
    setIsLoadingRepos(true);
    setRepoLoadError(null);

    try {
      // Load personal repos + orgs in parallel
      const [repoResult, orgResult] = await Promise.all([
        RepoList(REPO_FETCH_LIMIT, ''),
        loadUserOrganizations(),
      ]);

      // Build owner options (for the filter dropdown)
      const options: SelectOption[] = [{ value: '', label: 'All' }];
      if (ghUsername) {
        options.push({ value: ghUsername, label: `${ghUsername} (personal)` });
      }

      const allRepos: GroupedRepo[] = [];

      // Personal repos
      if (repoResult.success && repoResult.repos) {
        for (const repo of repoResult.repos) {
          const owner = repo.fullName.split('/')[0] || ghUsername;
          allRepos.push({ repo, owner });
        }
      } else if (repoResult.error) {
        throw new Error(repoResult.error);
      }

      // Org repos
      if (orgResult.success && orgResult.organizations) {
        const orgFetches = orgResult.organizations.map(async (org) => {
          options.push({
            value: org.login,
            label: org.name || org.login,
            description: org.login,
          });

          try {
            const orgRepos = await RepoListForOrg(org.login, REPO_FETCH_LIMIT);
            if (orgRepos.success && orgRepos.repos) {
              for (const repo of orgRepos.repos) {
                allRepos.push({ repo, owner: org.login });
              }
            }
          } catch {
            /* skip org on error */
          }
        });
        await Promise.all(orgFetches);
      } else if (orgResult.error) {
        throw new Error(orgResult.error);
      }

      // Deduplicate by fullName (personal list may include org repos)
      const seen = new Set<string>();
      const deduplicated: GroupedRepo[] = [];
      for (const entry of allRepos) {
        if (!seen.has(entry.repo.fullName)) {
          seen.add(entry.repo.fullName);
          deduplicated.push(entry);
        }
      }

      // Sort: recently updated first
      deduplicated.sort((a, b) => {
        if (a.repo.updatedAt && b.repo.updatedAt) {
          return b.repo.updatedAt.localeCompare(a.repo.updatedAt);
        }
        return a.repo.fullName.localeCompare(b.repo.fullName);
      });

      setOwnerOptions(options);
      setRepos(deduplicated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load repositories';
      console.error('Failed to load repositories:', err);
      setRepoLoadError(message);
      setRepos([]);
      setOwnerOptions(ghUsername ? [{ value: '', label: 'All' }, { value: ghUsername, label: `${ghUsername} (personal)` }] : [{ value: '', label: 'All' }]);
    } finally {
      setIsLoadingRepos(false);
    }
  }, [isLoggedIn, ghUsername, loadUserOrganizations]);

  useEffect(() => {
    if (isLoggedIn && !reposLoaded.current) {
      reposLoaded.current = true;
      loadReposAndOrgs();
    }
  }, [isLoggedIn, loadReposAndOrgs]);

  // Reset when auth changes to logged-out
  useEffect(() => {
    if (!isLoggedIn) {
      reposLoaded.current = false;
      setRepos([]);
      setOwnerOptions([]);
      setOwnerFilter('');
      setSelectedRepo(null);
      setRepoLoadError(null);
    }
  }, [isLoggedIn]);

  // ── GitHub auth handlers ──────────────────────────────────────────────

  const handleGitHubConnect = useCallback(async () => {
    setCloneError(null);
    await startDeviceFlow();
  }, [startDeviceFlow]);

  // ── Manual URL validation ─────────────────────────────────────────────

  const handleManualUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setManualUrl(value);
      if (value.trim() && !GIT_URL_RE.test(value.trim())) {
        setUrlError('Enter a valid HTTPS or SSH git URL');
      } else {
        setUrlError(null);
      }
    },
    [],
  );

  // ── Destination folder browsing ───────────────────────────────────────

  const handleBrowseDest = useCallback(async () => {
    setIsBrowsingDest(true);
    try {
      const result = await OpenFolderDialog();
      if (result.selected && result.path) {
        setDestPath(result.path);
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    } finally {
      setIsBrowsingDest(false);
    }
  }, []);

  // ── Stepper steps for clone flow ──────────────────────────────────────
  const cloneSteps = useMemo(() => [
    { id: 'clone', label: 'Cloning' },
    { id: 'done', label: 'Done' },
  ], []);

  // ── Clone ─────────────────────────────────────────────────────────────

  const handleClone = useCallback(async () => {
    if (!canClone) return;
    setIsCloning(true);
    setCloneError(null);
    setStepperStep(0);
    setStepperStatus('running');

    try {
      let repoIdentifier: string;

      if (inputMode === 'browse' && selectedRepo) {
        // Use owner/repo format (gh clone can handle this)
        repoIdentifier = selectedRepo.fullName;
      } else {
        repoIdentifier = manualUrl.trim();
      }

      const result = await RepoClone(repoIdentifier, destPath, isShallowClone);

      if (result.success) {
        // Step 1: Done
        setStepperStep(1);
        setStepperStatus('success');

        // Auto-open the cloned repo
        const clonedPath = result.cloneDir;
        if (clonedPath) {
          await openRepo(clonedPath);
        }
      } else {
        setStepperStatus('error');
        setCloneError(result.error || 'Clone failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStepperStatus('error');
      setCloneError(msg);
    } finally {
      setIsCloning(false);
    }
  }, [canClone, inputMode, selectedRepo, manualUrl, destPath, isShallowClone, openRepo]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-auto animate-screen-enter">
      <div className="max-w-2xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Download style={ICON_STYLES.md as CSSProperties} className="text-theme-muted" />
            <h2 className="text-xl text-theme-primary font-medium">Clone Project</h2>
          </div>
          <p className="text-theme-muted text-sm">
            Clone an existing repository from GitHub
          </p>
        </div>

        {/* Error banner */}
        {(repoLoadError || cloneError) && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3 mb-6">
            <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={16} />
            <span className="text-red-400 text-sm">{repoLoadError || cloneError}</span>
          </div>
        )}

        {/* ─── Section: Repository Source ─────────────────────────────── */}
        <SectionCard title="Repository" className="mb-6">
          {/* Mode tabs */}
          <div className="flex gap-1 p-0.5 bg-theme-elevated rounded-lg mb-4 w-fit">
            <button
              type="button"
              onClick={() => setInputMode('browse')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                inputMode === 'browse'
                  ? 'bg-theme-surface text-theme-primary shadow-sm'
                  : 'text-theme-muted hover:text-theme-secondary'
              }`}
            >
              Browse GitHub
            </button>
            <button
              type="button"
              onClick={() => setInputMode('url')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                inputMode === 'url'
                  ? 'bg-theme-surface text-theme-primary shadow-sm'
                  : 'text-theme-muted hover:text-theme-secondary'
              }`}
            >
              Paste URL
            </button>
          </div>

          {/* ── Browse mode ────────────────────────────────────────── */}
          {inputMode === 'browse' && (
            <div className="space-y-4">
              {/* GitHub account */}
              <div>
                <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                  GitHub Account
                </label>
                {!ghInstalled ? (
                  <div className="text-yellow-400 text-xs p-2 rounded bg-yellow-500/5 border border-yellow-500/20">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} />
                      <span>
                        {isInstallingPackages
                          ? 'Checking GitHub support… Please wait.'
                          : 'GitHub CLI is required to browse repositories.'}
                      </span>
                    </div>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={installRequiredPackages}
                        loading={isInstallingPackages}
                        disabled={isInstallingPackages}
                      >
                        <Github size={ICON_SIZES.xs} />
                        {isInstallingPackages ? 'Checking...' : 'Check supporting tools'}
                      </Button>
                    </div>
                  </div>
                ) : isLoggedIn ? (
                  <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded px-3 py-2">
                    <Check size={14} className="text-green-400" />
                    <Github size={14} className="text-theme-secondary" />
                    <span className="text-sm text-theme-primary">@{ghUsername}</span>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleGitHubConnect}
                    disabled={isCheckingGhAuth || isCloning || isInstallingPackages}
                  >
                    {isCheckingGhAuth ? (
                      <Loader2 className="animate-spin" size={14} />
                    ) : (
                      <Github style={{ width: ICON_SIZES.sm, height: ICON_SIZES.sm }} />
                    )}
                    <span className="ml-1.5">Connect GitHub Account</span>
                  </Button>
                )}
              </div>

              {/* Repo search + filter (shown after login) */}
              {isLoggedIn && (
                <>
                  {/* Owner filter + search */}
                  <div className="flex gap-2">
                    <div className="w-44 shrink-0">
                      <Select
                        value={ownerFilter}
                        onValueChange={setOwnerFilter}
                        options={ownerOptions}
                        placeholder="All owners"
                        disabled={isLoadingRepos || isCloning}
                      />
                    </div>
                    <div className="flex-1 relative">
                      <Search
                        size={14}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none"
                      />
                      <Input
                        value={repoSearchQuery}
                        onChange={(e) => setRepoSearchQuery(e.target.value)}
                        placeholder="Search repositories…"
                        className="pl-8 text-xs"
                        disabled={isLoadingRepos || isCloning}
                      />
                    </div>
                  </div>

                  {/* Repo list */}
                  <div className="border border-theme-default rounded-lg max-h-64 overflow-y-auto">
                    {isLoadingRepos ? (
                      <div className="flex items-center justify-center py-10 gap-2 text-theme-muted text-sm">
                        <Loader2 className="animate-spin" size={16} />
                        Loading repositories…
                      </div>
                    ) : filteredRepos.length === 0 ? (
                      <div className="text-center py-10 text-theme-muted text-sm">
                        {repoSearchQuery.trim()
                          ? 'No repositories match your search'
                          : 'No repositories found'}
                      </div>
                    ) : (
                      <div className="divide-y divide-theme-default">
                        {filteredRepos.map(({ repo }) => (
                          <RepoRow
                            key={repo.fullName}
                            repo={repo}
                            isSelected={selectedRepo?.fullName === repo.fullName}
                            onSelect={() => setSelectedRepo(repo)}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Selected repo summary */}
                  {selectedRepo && (
                    <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
                      <Check size={14} className="text-blue-400 shrink-0" />
                      <span className="text-blue-400 text-xs truncate">
                        Selected: <strong>{selectedRepo.fullName}</strong>
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── URL mode ───────────────────────────────────────────── */}
          {inputMode === 'url' && (
            <div>
              <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                Repository URL
              </label>
              <Input
                value={manualUrl}
                onChange={handleManualUrlChange}
                placeholder="https://github.com/owner/repo.git"
                className="text-xs"
                disabled={isCloning}
              />
              {urlError && (
                <p className="text-red-400 text-xs mt-1.5 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {urlError}
                </p>
              )}
              <p className="text-theme-muted text-xs mt-1.5">
                Supports HTTPS and SSH URLs
              </p>
            </div>
          )}
        </SectionCard>

        {/* ─── Section: Destination ───────────────────────────────────── */}
        <SectionCard title="Destination" className="mb-8">
          <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
            Clone Into
          </label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={destPath}
              placeholder="Select a destination folder…"
              className="flex-1 text-xs cursor-pointer"
              onClick={handleBrowseDest}
            />
            <Button
              variant="secondary"
              onClick={handleBrowseDest}
              disabled={isBrowsingDest || isCloning}
            >
              {isBrowsingDest ? (
                <Loader2 className="animate-spin" size={14} />
              ) : (
                <FolderOpen style={ICON_STYLES.sm as CSSProperties} />
              )}
              <span className="ml-1.5">Browse</span>
            </Button>
          </div>
          <p className="text-theme-muted text-xs mt-1.5">
            A new folder with the repository name will be created here.
          </p>

          <div className="mt-5 pt-4 border-t border-theme-default">
            <div className="flex items-center justify-between">
              <label className="block text-xs text-theme-secondary font-medium">
                Shallow Clone
              </label>
              <Switch
                checked={isShallowClone}
                onCheckedChange={setIsShallowClone}
                disabled={isCloning}
              />
            </div>
            <p className="text-theme-muted text-xs mt-1.5">
              Download only the latest snapshot of the repository to clone faster.
            </p>
          </div>
        </SectionCard>

        {/* ─── Progress stepper (shown during/after clone) ────────────── */}
        {stepperStatus !== 'idle' && (
          <div className="bg-theme-surface border border-theme-default rounded-lg p-5 mb-6">
            <ProjectCreationStepper
              steps={cloneSteps}
              currentStep={stepperStep}
              status={stepperStatus}
              error={stepperStatus === 'error' ? cloneError ?? undefined : undefined}
            />
          </div>
        )}

        {/* ─── Clone button ──────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-3">
          <Button size="lg" onClick={handleClone} disabled={!canClone}>
            {isCloning ? (
              <>
                <Loader2 className="animate-spin" size={16} />
                <span className="ml-2">Cloning…</span>
              </>
            ) : (
              <>
                <Download style={ICON_STYLES.sm as CSSProperties} />
                <span className="ml-1.5">Clone Project</span>
              </>
            )}
          </Button>
        </div>

        {/* GitHub Device Flow Modal */}
        <GitHubDeviceFlowModal
          open={deviceFlow.isOpen}
          userCode={deviceFlow.userCode}
          verificationUrl={deviceFlow.verificationUrl}
          onComplete={closeDeviceFlow}
          onOpenChange={handleDeviceFlowOpenChange}
        />
      </div>
    </div>
  );
}

export default memo(CloneProjectPage);
