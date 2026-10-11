/**
 * NewProjectPage - Initialize a new repository with version control.
 *
 * State machine based on folder detection:
 *  1. No path selected         → show form normally
 *  2. Path is NOT a git repo   → full form (Local + Remote + Create Project)
 *  3. Path IS a git repo       → "Already a project" card with "Open Project" button
 *
 * Sections:
 *  - Local Settings  — folder picker with inline validation
 *  - Remote Settings — GitHub auth, org picker, repo name (with availability check), visibility
 *                      plus "Skip Remote" toggle for local-only mode
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
  FolderPlus,
  FolderOpen,
  CheckCircle,
  FileText,
  GitBranch,
  AlertTriangle,
  AlertCircle,
  Loader2,
  Github,
  Check,
  Lock,
  Globe,
  Eye,
} from 'lucide-react';
import { ICON_SIZES } from '../../../shared/constants';
import { ICON_STYLES } from '../../../shared/utils/gitHelpers';
import { suggestRepoName, getFolderNameFromPath } from '../../../shared/utils/path';
import { useRepo } from '../../../context';
import GitHubDeviceFlowModal from '../../auth/components/GitHubDeviceFlowModal';
import ProjectCreationStepper, { type StepperStatus } from '../components/ProjectCreationStepper';
import { Button, Input, Select, Switch, ToggleGroup } from '../../../shared/ui';
import type { SelectOption } from '../../../shared/ui';
import { OpenFolderDialog } from '../../../../bindings/iofabrik/services/filedialogservice';
import { DetectRepo, GetRemoteURL } from '../../../../bindings/iofabrik/services/gitservice';
import { ListDirectory } from '../../../../bindings/iofabrik/services/filesystemservice';
import { CheckRepoNameExists } from '../../../../bindings/iofabrik/services/githubservice';
import { GetGitignoreTemplates } from '../../../../bindings/iofabrik/services/repositorysettingsservice';

// ============================================================================
// Types
// ============================================================================

/** Result of validating a selected folder path. */
type FolderValidation =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'empty-folder' }
  | { type: 'has-files'; count: number }
  | { type: 'already-repo'; branch: string; remoteUrl: string }
  | { type: 'nested-repo'; parentPath: string }
  | { type: 'not-found' }
  | { type: 'error'; message: string };

/** Name-availability check status for the GitHub repo name field. */
type NameCheckStatus = 'idle' | 'checking' | 'available' | 'taken' | 'error';

interface DeviceFlowState {
  isOpen: boolean;
  userCode: string;
  verificationUrl: string;
}

interface GitignoreTemplateOption {
  id: string;
  name: string;
  description: string;
  category: string;
}

// ============================================================================
// Constants
// ============================================================================

const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Private', icon: <Lock size={12} /> },
  { value: 'public', label: 'Public', icon: <Globe size={12} /> },
];

const DEBOUNCE_MS = 400;
const NO_GITIGNORE_TEMPLATE = '__none__';

// ============================================================================
// Sub-components
// ============================================================================

/** Inline validation banner shown below the folder path input. */
function FolderValidationBanner({ validation }: { validation: FolderValidation }) {
  switch (validation.type) {
    case 'idle':
    case 'loading':
      return null;
    case 'empty-folder':
      return (
        <div className="flex items-center gap-2 text-theme-secondary text-xs mt-2">
          <CheckCircle size={14} />
          <span>Empty folder — ready for a new project</span>
        </div>
      );
    case 'has-files':
      return (
        <div className="flex items-center gap-2 text-theme-secondary text-xs mt-2">
          <FileText size={14} />
          <span>{validation.count} file{validation.count !== 1 ? 's' : ''} found — will be included in initial commit</span>
        </div>
      );
    case 'already-repo':
      // Handled at a higher level (switches form mode)
      return null;
    case 'nested-repo':
      return (
        <div className="flex items-center gap-2 text-yellow-400 text-xs mt-2">
          <AlertTriangle size={14} />
          <span>This folder is inside another git repository. This may cause issues.</span>
        </div>
      );
    case 'not-found':
      return (
        <div className="flex items-center gap-2 text-red-400 text-xs mt-2">
          <AlertCircle size={14} />
          <span>Folder not found</span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-center gap-2 text-red-400 text-xs mt-2">
          <AlertCircle size={14} />
          <span>{validation.message}</span>
        </div>
      );
    default:
      return null;
  }
}

/** "Already a Git Project" card — replaces the full form. */
function AlreadyAProjectCard({
  path,
  branch,
  remoteUrl,
  onOpen,
}: {
  path: string;
  branch: string;
  remoteUrl: string;
  onOpen: () => void;
}) {
  const folderName = getFolderNameFromPath(path);

  return (
    <div className="border border-theme-default rounded-lg p-6 bg-theme-surface">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-lg bg-theme-hover border border-theme-default">
          <GitBranch style={ICON_STYLES.lg as CSSProperties} className="text-theme-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-theme-primary mb-1">{folderName}</h3>
          <p className="text-theme-muted text-xs font-mono truncate mb-3">{path}</p>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-theme-secondary mb-5">
            {branch && (
              <span className="flex items-center gap-1.5">
                <GitBranch size={12} className="text-theme-muted" />
                {branch}
              </span>
            )}
            {remoteUrl && (
              <span className="flex items-center gap-1.5">
                <Globe size={12} className="text-theme-muted" />
                {remoteUrl}
              </span>
            )}
          </div>

          <Button size="lg" onClick={onOpen}>
            <FolderOpen style={ICON_STYLES.sm as CSSProperties} />
            Open Project
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

interface NewProjectPageProps {
  prefillPath?: string;
  onPrefillApplied?: () => void;
}

function NewProjectPage({ prefillPath = '', onPrefillApplied }: NewProjectPageProps): JSX.Element {
  const {
    openRepo,
    ghInstalled,
    isInstallingPackages,
    installRequiredPackages,
    ghAuthStatus,
    isCheckingGhAuth,
    startGitHubLogin,
    loadUserOrganizations,
    createProject,
  } = useRepo();

  // ── Local settings state ──────────────────────────────────────────────
  const [selectedPath, setSelectedPath] = useState('');
  const [validation, setValidation] = useState<FolderValidation>({ type: 'idle' });
  const [isBrowsing, setIsBrowsing] = useState(false);

  // ── Remote settings state ─────────────────────────────────────────────
  const [skipRemote, setSkipRemote] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [selectedOwner, setSelectedOwner] = useState('');  // '' = personal account
  const [visibility, setVisibility] = useState('private');
  const [selectedGitignoreTemplate, setSelectedGitignoreTemplate] = useState(NO_GITIGNORE_TEMPLATE);
  const [gitignoreTemplates, setGitignoreTemplates] = useState<GitignoreTemplateOption[]>([]);
  const [ownerOptions, setOwnerOptions] = useState<SelectOption[]>([]);
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);
  const [nameCheckStatus, setNameCheckStatus] = useState<NameCheckStatus>('idle');

  // ── Device flow modal state ───────────────────────────────────────────
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({
    isOpen: false,
    userCode: '',
    verificationUrl: '',
  });

  // ── Creation state ────────────────────────────────────────────────────
  const [isCreating, setIsCreating] = useState(false);
  const [stepperStep, setStepperStep] = useState(0);
  const [stepperStatus, setStepperStatus] = useState<StepperStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────
  const nameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orgsLoaded = useRef(false);

  // ── Derived state ─────────────────────────────────────────────────────
  const isAlreadyRepo = validation.type === 'already-repo';
  const isLoggedIn = ghAuthStatus?.loggedIn === true;
  const ghUsername = ghAuthStatus?.username ?? '';

  // Whether the "Create Project" button should be enabled
  const canCreate = useMemo(() => {
    if (!selectedPath) return false;
    if (validation.type === 'loading' || validation.type === 'not-found' || validation.type === 'error') return false;
    if (isAlreadyRepo) return false;
    if (isCreating) return false;
    if (!skipRemote) {
      if (!isLoggedIn) return false;
      if (!repoName.trim()) return false;
      if (nameCheckStatus === 'taken' || nameCheckStatus === 'checking') return false;
    }
    return true;
  }, [selectedPath, validation, isAlreadyRepo, isCreating, skipRemote, isLoggedIn, repoName, nameCheckStatus]);

  // ── Folder validation ─────────────────────────────────────────────────

  const validateFolder = useCallback(async (path: string) => {
    if (!path) {
      setValidation({ type: 'idle' });
      return;
    }

    setValidation({ type: 'loading' });

    try {
      // 1. Check if folder is a git repo
      const info = await DetectRepo(path);

      if (info.hasError) {
        // Path probably doesn't exist
        setValidation({ type: 'not-found' });
        return;
      }

      if (info.isRepo) {
        // It's a git repo — check if it's the repo root or nested
        const repoRoot = info.path;
        const isNested = repoRoot !== '' && repoRoot !== path;

        if (isNested) {
          setValidation({ type: 'nested-repo', parentPath: repoRoot });
        } else {
          // It's the repo root — fetch remote + branch info for the card
          let remoteUrl = '';
          try {
            remoteUrl = await GetRemoteURL(path);
          } catch { /* no remote */ }

          setValidation({
            type: 'already-repo',
            branch: info.branch || 'main',
            remoteUrl,
          });
        }
        return;
      }

      // 2. Not a repo — count files
      try {
        const contents = await ListDirectory(path);
        const fileCount = contents.entries?.length ?? 0;

        if (fileCount === 0) {
          setValidation({ type: 'empty-folder' });
        } else {
          setValidation({ type: 'has-files', count: fileCount });
        }
      } catch {
        // Could not list directory — likely doesn't exist
        setValidation({ type: 'not-found' });
      }
    } catch (err) {
      setValidation({ type: 'error', message: String(err) });
    }
  }, []);

  // ── Browse for folder ─────────────────────────────────────────────────

  const handleBrowse = useCallback(async () => {
    setIsBrowsing(true);
    setError(null);
    try {
      const result = await OpenFolderDialog();
      if (result.selected && result.path) {
        setSelectedPath(result.path);
        setRepoName(suggestRepoName(result.path));
        setNameCheckStatus('idle');
        await validateFolder(result.path);
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    } finally {
      setIsBrowsing(false);
    }
  }, [validateFolder]);

  // ── GitHub auth ───────────────────────────────────────────────────────

  const handleGitHubConnect = useCallback(async () => {
    setError(null);
    const result = await startGitHubLogin();
    if (result.success && result.userCode) {
      setDeviceFlow({
        isOpen: true,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl || 'https://github.com/login/device',
      });
    } else {
      setError(result.error || 'Failed to start GitHub authentication');
    }
  }, [startGitHubLogin]);

  const handleCloseDeviceFlow = useCallback(() => {
    setDeviceFlow({ isOpen: false, userCode: '', verificationUrl: '' });
  }, []);

  const handleDeviceFlowOpenChange = useCallback((open: boolean): void => {
    if (!open) {
      handleCloseDeviceFlow();
    }
  }, [handleCloseDeviceFlow]);

  // ── Load organizations once after login ───────────────────────────────

  useEffect(() => {
    if (!isLoggedIn || orgsLoaded.current) return;
    orgsLoaded.current = true;

    (async () => {
      setIsLoadingOrgs(true);
      try {
        const result = await loadUserOrganizations();
        if (result.success) {
          const options: SelectOption[] = [
            { value: '', label: `${result.username} (personal)` },
            ...result.organizations.map(org => ({
              value: org.login,
              label: org.name || org.login,
              description: org.login,
            })),
          ];
          setOwnerOptions(options);
        }
      } catch { /* ignore */ }
      setIsLoadingOrgs(false);
    })();
  }, [isLoggedIn, loadUserOrganizations]);

  // Reset orgs loaded flag when auth changes to logged-out
  useEffect(() => {
    if (!isLoggedIn) {
      orgsLoaded.current = false;
      setOwnerOptions([]);
      setSelectedOwner('');
    }
  }, [isLoggedIn]);

  // ── Load .gitignore templates ────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const templates = await GetGitignoreTemplates();
        setGitignoreTemplates(templates as GitignoreTemplateOption[]);
      } catch {
        setGitignoreTemplates([]);
      }
    })();
  }, []);

  // Apply externally provided path (e.g., from non-git folder prompt)
  useEffect(() => {
    if (!prefillPath) return;

    setSelectedPath(prefillPath);
    setRepoName(suggestRepoName(prefillPath));
    setNameCheckStatus('idle');
    setError(null);

    void validateFolder(prefillPath);
    onPrefillApplied?.();
  }, [prefillPath, validateFolder, onPrefillApplied]);

  const gitignoreOptions = useMemo((): SelectOption[] => {
    return [
      { value: NO_GITIGNORE_TEMPLATE, label: 'None' },
      ...gitignoreTemplates.map((template) => ({
        value: template.id,
        label: `${template.name} · ${template.category}`,
        description: template.description,
      })),
    ];
  }, [gitignoreTemplates]);

  // ── Repo name availability check (debounced) ─────────────────────────

  const checkRepoName = useCallback(
    (name: string, owner: string) => {
      if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);

      if (!name.trim() || !isLoggedIn) {
        setNameCheckStatus('idle');
        return;
      }

      setNameCheckStatus('checking');

      nameCheckTimer.current = setTimeout(async () => {
        try {
          const effectiveOwner = owner || ghUsername;
          const result = await CheckRepoNameExists(effectiveOwner, name.trim());
          if (result.error) {
            setNameCheckStatus('error');
          } else {
            setNameCheckStatus(result.exists ? 'taken' : 'available');
          }
        } catch {
          setNameCheckStatus('error');
        }
      }, DEBOUNCE_MS);
    },
    [isLoggedIn, ghUsername],
  );

  // Cleanup pending debounce timer on unmount
  useEffect(() => {
    return () => {
      if (nameCheckTimer.current) {
        clearTimeout(nameCheckTimer.current);
      }
    };
  }, []);

  const handleRepoNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setRepoName(value);
      if (!skipRemote) {
        checkRepoName(value, selectedOwner);
      }
    },
    [skipRemote, selectedOwner, checkRepoName],
  );

  const handleOwnerChange = useCallback(
    (value: string) => {
      setSelectedOwner(value);
      if (repoName.trim() && !skipRemote) {
        checkRepoName(repoName, value);
      }
    },
    [repoName, skipRemote, checkRepoName],
  );

  // ── Stepper step definitions ───────────────────────────────────────────
  const stepperSteps = useMemo(() => {
    const steps = [
      { id: 'init', label: 'Initializing' },
      { id: 'commit', label: 'Saving Changes' },
    ];
    if (!skipRemote) {
      steps.push({ id: 'publish', label: 'Publishing' });
    }
    steps.push({ id: 'done', label: 'Done' });
    return steps;
  }, [skipRemote]);

  const selectedTemplate = useMemo(() => {
    if (selectedGitignoreTemplate === NO_GITIGNORE_TEMPLATE) return null;
    return gitignoreTemplates.find((template) => template.id === selectedGitignoreTemplate) ?? null;
  }, [selectedGitignoreTemplate, gitignoreTemplates]);

  // ── Create project ────────────────────────────────────────────────────

  const handleCreateProject = useCallback(async () => {
    if (!canCreate) return;
    setIsCreating(true);
    setError(null);
    setStepperStep(0);
    setStepperStatus('running');

    const result = await createProject({
      path: selectedPath,
      gitignoreTemplateId: selectedGitignoreTemplate !== NO_GITIGNORE_TEMPLATE
        ? selectedGitignoreTemplate
        : undefined,
      remote: {
        skip: skipRemote,
        owner: selectedOwner || undefined,
        repoName: repoName.trim() || undefined,
        isPrivate: visibility === 'private',
      },
      onStepChange: (step: number) => {
        // Map the 4-step orchestrator (0-init,1-commit,2-publish,3-done)
        // to the stepper's step array which may not have a "publish" entry.
        if (skipRemote) {
          // steps: [init, commit, done] → indices 0,1,2
          // orchestrator step 3 (done) maps to index 2
          setStepperStep(step <= 1 ? step : step - 1);
        } else {
          setStepperStep(step);
        }
      },
    });

    if (result.success) {
      setStepperStatus('success');
    } else {
      setStepperStatus('error');
      setError(result.error || 'Failed to create project');
    }

    setIsCreating(false);
  }, [
    canCreate,
    selectedPath,
    createProject,
    skipRemote,
    selectedOwner,
    repoName,
    visibility,
    selectedGitignoreTemplate,
  ]);

  // ── Open existing project (from "Already a Project" card) ─────────────

  const handleOpenExisting = useCallback(() => {
    if (selectedPath) openRepo(selectedPath);
  }, [selectedPath, openRepo]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-auto animate-screen-enter">
      <div className="max-w-6xl mx-auto p-6 lg:p-8">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <FolderPlus style={ICON_STYLES.md as CSSProperties} className="text-theme-muted" />
            <h2 className="text-xl text-theme-primary font-medium">New Project</h2>
          </div>
          <p className="text-theme-muted text-sm">
            Pick a folder, choose your backup settings, then create the project.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3 mb-6">
            <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={16} />
            <span className="text-red-400 text-sm">{error}</span>
          </div>
        )}

        {/* ── Already a git project mode ─────────────────────────────── */}
        {isAlreadyRepo && validation.type === 'already-repo' && (
          <>
            {/* Show the path that was selected so the user remembers */}
            <SectionCard title="Project File Path" className="mb-4">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={selectedPath}
                  placeholder="No folder selected"
                  className="flex-1 text-xs"
                />
                <Button variant="secondary" onClick={handleBrowse} disabled={isBrowsing}>
                  {isBrowsing ? <Loader2 className="animate-spin" size={14} /> : <FolderOpen style={ICON_STYLES.sm as CSSProperties} />}
                  <span className="ml-1.5">Browse</span>
                </Button>
              </div>
            </SectionCard>

            <AlreadyAProjectCard
              path={selectedPath}
              branch={validation.branch}
              remoteUrl={validation.remoteUrl}
              onOpen={handleOpenExisting}
            />
          </>
        )}

        {/* ── Normal form mode ───────────────────────────────────────── */}
        {!isAlreadyRepo && (
          <>
            <div className="max-w-3xl mx-auto">
              <SectionCard title="Project Folder" className="mb-6">
                <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                  Project File Path
                </label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={selectedPath}
                    placeholder="Select a folder…"
                    className="flex-1 text-xs cursor-pointer"
                    onClick={handleBrowse}
                  />
                  <Button variant="secondary" onClick={handleBrowse} disabled={isBrowsing || isCreating}>
                    {isBrowsing ? <Loader2 className="animate-spin" size={14} /> : <FolderOpen style={ICON_STYLES.sm as CSSProperties} />}
                    <span className="ml-1.5">Browse</span>
                  </Button>
                </div>
                {validation.type === 'loading' && (
                  <div className="flex items-center gap-2 text-theme-muted text-xs mt-2">
                    <Loader2 className="animate-spin" size={12} />
                    <span>Checking folder…</span>
                  </div>
                )}
                <FolderValidationBanner validation={validation} />

                <div className="mt-5 pt-4 border-t border-theme-default">
                  <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                    .gitignore Template
                  </label>
                  <Select
                    value={selectedGitignoreTemplate}
                    onValueChange={setSelectedGitignoreTemplate}
                    options={gitignoreOptions}
                    placeholder="Select template"
                    disabled={isCreating}
                  />
                  <p className="text-theme-muted text-xs mt-1.5">
                    {selectedTemplate
                      ? selectedTemplate.description
                      : 'Optional. Pick one if your project uses PLC or CAD/3D tooling.'}
                  </p>
                </div>
              </SectionCard>

              <SectionCard title="Cloud Backup (GitHub)" className="mb-8">
              {/* Skip remote toggle */}
              <div className="flex items-center justify-between mb-5">
                <div>
                  <p className="text-sm text-theme-primary">Local only</p>
                  <p className="text-xs text-theme-muted">Skip cloud backup for now. You can publish later.</p>
                </div>
                <Switch checked={skipRemote} onCheckedChange={setSkipRemote} disabled={isCreating} />
              </div>

              {!skipRemote && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* GitHub account */}
                  <div className="lg:col-span-2">
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
                              : 'GitHub CLI is required to enable cloud backup.'}
                          </span>
                        </div>
                        <div className="mt-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={installRequiredPackages}
                            loading={isInstallingPackages}
                            disabled={isInstallingPackages || isCreating}
                          >
                            <Github size={ICON_SIZES.xs} />
                            {isInstallingPackages ? 'Checking...' : 'Check supporting tools'}
                          </Button>
                        </div>
                      </div>
                    ) : isLoggedIn ? (
                      <div className="flex items-center gap-2 bg-theme-hover border border-theme-default rounded px-3 py-2">
                        <Check size={14} className="text-theme-muted" />
                        <Github size={14} className="text-theme-secondary" />
                        <span className="text-sm text-theme-primary">@{ghUsername}</span>
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleGitHubConnect}
                        disabled={isCheckingGhAuth || isCreating || isInstallingPackages}
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

                  {/* Organization picker */}
                  <div>
                    <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                      Organization
                    </label>
                    <Select
                      value={selectedOwner}
                      onValueChange={handleOwnerChange}
                      options={ownerOptions}
                      placeholder={isLoadingOrgs ? 'Loading…' : 'Personal account'}
                      disabled={!isLoggedIn || isLoadingOrgs || isCreating}
                    />
                  </div>

                  {/* Repository name */}
                  <div>
                    <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                      Repository Name
                    </label>
                    <div className="relative">
                      <Input
                        value={repoName}
                        onChange={handleRepoNameChange}
                        placeholder="my-project"
                        disabled={!isLoggedIn || isCreating}
                        className="pr-8"
                      />
                      <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                        {nameCheckStatus === 'checking' && (
                          <Loader2 className="animate-spin text-theme-muted" size={14} />
                        )}
                        {nameCheckStatus === 'available' && (
                          <CheckCircle size={14} className="text-theme-muted" />
                        )}
                        {nameCheckStatus === 'taken' && (
                          <AlertCircle size={14} className="text-red-400" />
                        )}
                      </div>
                    </div>
                    {nameCheckStatus === 'available' && (
                      <p className="text-theme-muted text-xs mt-1">Name available</p>
                    )}
                    {nameCheckStatus === 'taken' && (
                      <p className="text-red-400 text-xs mt-1">Repository already exists</p>
                    )}
                    {nameCheckStatus === 'error' && (
                      <p className="text-yellow-400 text-xs mt-1">Could not check availability</p>
                    )}
                  </div>

                  {/* Visibility */}
                  <div className="lg:col-span-2">
                    <label className="block text-xs text-theme-secondary mb-1.5 font-medium">
                      Visibility
                    </label>
                    <ToggleGroup
                      value={visibility}
                      onValueChange={setVisibility}
                      options={VISIBILITY_OPTIONS}
                      disabled={!isLoggedIn || isCreating}
                    />
                    <p className="text-theme-muted text-xs mt-1.5">
                      {visibility === 'private' ? (
                        <span className="flex items-center gap-1"><Eye size={11} /> Only you and collaborators can view this repository</span>
                      ) : (
                        <span className="flex items-center gap-1"><Globe size={11} /> Anyone on the internet can view this repository</span>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {skipRemote && (
                <p className="text-theme-muted text-xs italic">
                  You can publish to GitHub later from repository settings.
                </p>
              )}
              </SectionCard>
            </div>

            {/* ─── Progress stepper (shown during/after creation) ───── */}
            {stepperStatus !== 'idle' && (
              <div className="max-w-3xl mx-auto bg-theme-surface border border-theme-default rounded-lg p-5 mb-6">
                <ProjectCreationStepper
                  steps={stepperSteps}
                  currentStep={stepperStep}
                  status={stepperStatus}
                  error={stepperStatus === 'error' ? error ?? undefined : undefined}
                />
              </div>
            )}

            {/* ─── Create button ────────────────────────────────────── */}
            <div className="max-w-3xl mx-auto flex items-center justify-end gap-3">
              <Button
                size="lg"
                onClick={handleCreateProject}
                disabled={!canCreate}
              >
                {isCreating ? (
                  <>
                    <Loader2 className="animate-spin" size={16} />
                    <span className="ml-2">Creating…</span>
                  </>
                ) : (
                  <>
                    <FolderPlus style={ICON_STYLES.sm as CSSProperties} />
                    <span className="ml-1.5">Create Project</span>
                  </>
                )}
              </Button>
            </div>
          </>
        )}

        {/* GitHub Device Flow Modal */}
        <GitHubDeviceFlowModal
          open={deviceFlow.isOpen}
          userCode={deviceFlow.userCode}
          verificationUrl={deviceFlow.verificationUrl}
          onComplete={handleCloseDeviceFlow}
          onOpenChange={handleDeviceFlowOpenChange}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Shared section card wrapper (mirrors SettingsPage card style)
// ============================================================================

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

export default memo(NewProjectPage);
