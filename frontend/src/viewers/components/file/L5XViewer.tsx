/**
 * L5XViewer - Displays Rockwell Automation L5X ladder logic files.
 * 
 * Features:
 * - Multi-tab interface for viewing different content types
 * - Ladder diagrams with virtualized rendering (RLL routines)
 * - Structured Text viewer (ST routines)
 * - Program navigation tree with full item selection
 * - Tag tables (controller and program-level)
 * - Controller information
 * - Data type structure viewer
 * - AOI parameters and local tags
 * - Module information
 * - Parsed data caching for tab persistence
 * 
 * Supports both light and dark themes via CSS custom properties.
 */
import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Cpu, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import { ICON_SIZES } from '../../../shared/constants';
import { onEvent } from '../../../shared/runtime/events';
import type { ViewerProps } from '../../registry/viewer-registry';
import { invalidateCachedContent, useCachedContent } from '../../registry/viewer-cache';
import { getPathFileName } from '../shared/path-utils';
import L5XProjectOrganizer from '../shared/L5XProjectOrganizer';
import { organizerSelectionId } from '../shared/l5x-organizer-model';
import L5XDocumentStatus from '../shared/L5XDocumentStatus';
import { parseL5XDocument, type L5XDocumentResult } from '../shared/l5x-document';

// Import ladder-visualizer components and parsers
import {
  ControllerInfo,
  TagTable,
  ModuleInfoTable,
  registerAOIsFromController,
  clearAOIs,
  type NormalizedDataType,
  type NormalizedController,
} from 'ladder-visualizer';

// Import local tab components
import { TabBar, useTabs, type TabData } from './l5x';
import { normalizeTabData } from './l5x/useTabs';
import DataTypeView from './l5x/DataTypeView';
import { L5XRoutineViewer } from './l5x/L5XRoutineViewer';
import MetadataInspector from './l5x/MetadataInspector';
import DocumentInspector from './l5x/DocumentInspector';
import { buildDocumentRecords } from './l5x/document-model';
import DeclarationView from './l5x/DeclarationView';
import ControllerCollections from './l5x/ControllerCollections';
import EmptyState from '../../../shared/ui/EmptyState';
import { Button } from '../../../shared/ui/button';
import { findProgram } from './l5x/program-identity';

function resolveProgram(controller: NormalizedController, data: { programIndex: number; programName?: string; programUid?: string; programUidAmbiguous?: boolean }, ambiguousProgramUids: ReadonlySet<string>) {
  return findProgram(controller.programs, { uid: data.programUid, name: data.programName, index: data.programIndex, ambiguousUid: data.programUidAmbiguous }, ambiguousProgramUids);
}

// Note: ladder-visualizer CSS is imported via index.css to work with Vite's CSS handling

// ============================================================================
// Types
// ============================================================================

interface L5XViewerUIState {
  showNavigator: boolean;
}

// ============================================================================
// L5XViewer Component
// ============================================================================

/**
 * L5XViewer - Displays Rockwell Automation L5X ladder logic files.
 * Part of the multi-viewer architecture.
 * Uses cached parsed data to persist across tab switches.
 */
function L5XViewer({ filePath, onShowRaw }: ViewerProps & { onShowRaw?: () => void }): JSX.Element {
  // UI state (not cached - should reset on new file)
  const [uiState, setUIState] = useState<L5XViewerUIState>({
    showNavigator: true,
  });
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [fbdSheetIndices, setFbdSheetIndices] = useState<Record<string, number>>({});

  // Tab management - internal to L5X viewer, cached by filePath

  const normalizedFilePath = useMemo(() => filePath.replace(/\\/g, '/'), [filePath]);

  useEffect(() => {
    const handleFilesChanged = (event: {
      data?: {
        path?: string;
        eventType?: string;
        isDir?: boolean;
      };
    }) => {
      const changedPath = event.data?.path?.replace(/\\/g, '/');
      const eventType = event.data?.eventType;
      const isDir = event.data?.isDir;

      if (!changedPath || isDir) return;
      if (eventType !== 'write' && eventType !== 'rename' && eventType !== 'remove') return;

      const samePath =
        changedPath === normalizedFilePath ||
        changedPath.toLowerCase() === normalizedFilePath.toLowerCase();

      if (!samePath) return;

      invalidateCachedContent(filePath);
      invalidateCachedContent(`l5x:${filePath}`);
      setRefreshCounter((current) => current + 1);
    };

    const unsubscribe = onEvent('files-changed', handleFilesChanged);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [filePath, normalizedFilePath]);

  // Loader function for cached content - parses L5X file
  const loadAndParseFile = useCallback(async (): Promise<L5XDocumentResult> => {
    const result = await ReadTextFile(filePath);
    
    if (!result.success) {
      throw new Error(result.error?.includes('max 10MB')
        ? 'This file exceeds the 10 MB text viewer limit. Open it in the default app to inspect it.'
        : 'Cannot read this file. Check that it is available, then reopen it.');
    }

    return parseL5XDocument(result.content || '');
  }, [filePath]);

  // Use cached content - persists across tab/view switches
  const { data: documentResult, error, isLoading } = useCachedContent<L5XDocumentResult>(
    `l5x:${filePath}`,
    loadAndParseFile,
    [refreshCounter]
  );
  const document = documentResult?.data;
  const initializedFile = useRef<string | null>(null);
  const controller = documentResult?.controller ?? null;
  const { tabs, activeTabId, openTab, closeTab, selectTab, ambiguousProgramUids } = useTabs(filePath, controller?.programs);
  const documentRecords = useMemo(() => document ? buildDocumentRecords(document, ambiguousProgramUids) : [], [document, ambiguousProgramUids]);

  // Register AOIs when controller data is available (from cache or fresh load)
  useEffect(() => {
    clearAOIs();
    if (controller) {
      // Re-register AOIs - needed for proper parameter labels
      registerAOIsFromController(controller);
    }
  }, [controller]);

  // Toggle navigator visibility
  const toggleNavigator = useCallback(() => {
    setUIState(prev => ({ ...prev, showNavigator: !prev.showNavigator }));
  }, []);

  // ============================================================================
  // Navigator Event Handlers
  // ============================================================================

  const handleOpen = useCallback((data: TabData, title: string) => {
    data = normalizeTabData(data);
    const selectionId = controller ? organizerSelectionId(controller, data, ambiguousProgramUids) : undefined;
    const existing = selectionId && tabs.find(tab => tab.type === data.type &&
      organizerSelectionId(controller!, tab.data, ambiguousProgramUids) === selectionId);
    openTab(data, data.type === 'data-type' ? data.dataTypeName : title, existing ? existing.id : undefined);
  }, [controller, ambiguousProgramUids, tabs, openTab]);

  // Initialize component exports once. Cached tabs and user selections survive refresh.
  useEffect(() => {
    if (!document || initializedFile.current === filePath) return;
    initializedFile.current = filePath;
    if (tabs.length || document.source.targetType === 'Controller') return;
    const target = documentRecords.find(record => record.group === 'Targets');
    openTab({ type: 'document', selection: target?.selection ?? { kind: 'source' } }, target?.title ?? 'Document');
  }, [document, documentRecords, filePath, tabs.length, openTab]);

  const handleDataTypeSelect = useCallback((dataType: NormalizedDataType) => {
    handleOpen(
      { type: 'data-type', dataTypeName: dataType.name },
      dataType.name
    );
  }, [handleOpen]);

  const activeTabData = useMemo(() => {
    if (!activeTabId) return null;
    const tab = tabs.find(t => t.id === activeTabId);
    return tab?.data || null;
  }, [activeTabId, tabs]);

  // ============================================================================
  // Tab Content Rendering
  // ============================================================================

  const renderTabContent = useCallback((tabData: TabData, isActive: boolean, tabId: string) => {
    if (tabData.type === 'document') return document ? <div key={tabId} hidden={!isActive} aria-hidden={!isActive}
      className={`flex h-full min-h-0 min-w-0 flex-col ${isActive ? '' : 'hidden'}`}>
      <DocumentInspector document={document} records={documentRecords} controller={controller} selection={tabData.selection}
        onOpen={handleOpen} onShowRaw={onShowRaw}
        fbdSheetIndex={fbdSheetIndices[`${normalizedFilePath}:${tabId}`] ?? 0}
        onFbdSheetIndexChange={index => setFbdSheetIndices(current => ({ ...current, [`${normalizedFilePath}:${tabId}`]: index }))} />
    </div> : null;
    if (!controller) return null;

    const containerClass = `flex-1 flex flex-col overflow-hidden h-full ${isActive ? '' : 'hidden'}`;
    const ladderContentClass = 'flex-1 overflow-hidden';
    const dataTypes = controller.dataTypeCatalog ?? controller.dataTypes;

    switch (tabData.type) {
      case 'metadata':
        return <div key={tabId} className={containerClass}>
          <div className="min-h-0 flex-1 overflow-auto">
            <MetadataInspector controller={controller} target={tabData.target} onOpen={handleOpen} onShowRaw={onShowRaw} ambiguousProgramUids={ambiguousProgramUids} />
          </div>
        </div>;
      case 'controller-tags':
        return (
          <div key="controller-tags" className={containerClass}>
            <div className="flex-1 overflow-auto p-4">
              <TagTable tags={controller.tags} dataTypes={dataTypes} />
            </div>
          </div>
        );

      case 'program-tags': {
        const program = resolveProgram(controller, tabData, ambiguousProgramUids);
        const tags = program?.tags ?? [];
        return (
          <div key={tabId} className={containerClass}>
            <div className="flex-1 overflow-auto p-4">
              {!program ? <p className="text-center text-theme-secondary py-10">This program is no longer in the file. Select another item in the Project Organizer.</p> : tags.length > 0 ? (
                <TagTable tags={tags} dataTypes={dataTypes} />
              ) : (
                <p className="text-center text-theme-secondary py-10">No program-specific tags defined</p>
              )}
            </div>
          </div>
        );
      }

      case 'controller-info':
        return (
          <div key="controller-info" className={containerClass}>
            <div className="flex-1 overflow-auto p-4">
              <ControllerInfo controller={controller} className="max-w-2xl" />
            </div>
          </div>
        );

      case 'data-type': {
        return <div key={tabId} className={containerClass}>
          <DataTypeView controller={controller} dataTypeName={tabData.dataTypeName} view={tabData.view}
            onViewChange={view => openTab({ ...tabData, view }, tabData.dataTypeName, tabId)}
            onDataTypeSelect={handleDataTypeSelect} onOpen={handleOpen} onShowRaw={onShowRaw} />
        </div>;
      }

      case 'program-local-tags':
      case 'program-parameters':
      case 'aoi-parameters':
      case 'aoi-local-tags': {
        const aois = 'aoiName' in tabData ? controller.aois.filter(aoi => aoi.name === tabData.aoiName) : undefined;
        const owner = 'programIndex' in tabData ? resolveProgram(controller, tabData, ambiguousProgramUids)
          : aois?.length === 1 ? aois[0] : undefined;
        const parameters = tabData.type === 'program-parameters' || tabData.type === 'aoi-parameters';
        const declarations = owner && (parameters ? owner.parameters : owner.localTags);
        return <div key={tabId} className={containerClass}><section className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-theme-primary"
          aria-label="Declaration view">
          <h2 className="break-words text-sm font-semibold">{owner?.name} {parameters ? 'Parameters' : 'Local Tags'}</h2>
          {!owner ? <>
            <EmptyState customMessage="This owner is missing or ambiguous. Select another item in the Project Organizer." />
            {onShowRaw && <Button variant="ghost" size="sm" onClick={onShowRaw}>View Raw</Button>}
          </> : !declarations?.length ? <EmptyState customMessage="No declarations in this collection. Select another item in the Project Organizer." />
            : <DeclarationView declarations={declarations} catalog={dataTypes} onOpen={handleOpen} />}
        </section></div>;
      }

      case 'trends':
      case 'watch-lists': {
        const count = tabData.type === 'trends' ? controller.trends?.length : controller.quickWatchLists?.length;
        return <div key={tabId} className={containerClass}><section className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-theme-primary">
          <h2 className="break-words text-sm font-semibold">{controller.name} {tabData.type === 'trends' ? 'Trends' : 'Quick Watch Lists'}</h2>
          {!count ? <EmptyState customMessage="No entries in this collection. Select another item in the Project Organizer." />
            : <ControllerCollections controller={controller} type={tabData.type} onOpen={handleOpen} />}
        </section></div>;
      }

      case 'aoi-routine': {
        const aoi = controller.aois.find(a => a.name === tabData.aoiName);
        const routine = tabData.routineName !== undefined ? aoi?.routines.find(item => item.name === tabData.routineName) : aoi?.routines[tabData.routineIndex];
        const routineKey = `${normalizedFilePath}:${tabId}`;
        if (aoi && routine) {
          return (
            <div key={tabId} className={containerClass}>
              <div className={ladderContentClass}>
                <L5XRoutineViewer
                  routine={routine}
                  fbdSheetIndex={fbdSheetIndices[routineKey] ?? 0}
                  onFbdSheetIndexChange={(sheetIndex) => {
                    setFbdSheetIndices((current) => ({ ...current, [routineKey]: sheetIndex }));
                  }}
                />
              </div>
            </div>
          );
        }
        return (
          <div key={tabId} className={containerClass}>
            <p className="text-center text-theme-secondary py-10">AOI routine not found</p>
          </div>
        );
      }

      case 'routine': {
        const program = resolveProgram(controller, tabData, ambiguousProgramUids);
        const routine = tabData.routineName !== undefined ? program?.routines.find(item => item.name === tabData.routineName) : program?.routines[tabData.routineIndex];
        const routineKey = `${normalizedFilePath}:${tabId}`;
        if (routine) {
          return (
            <div key={tabId} className={containerClass}>
              <div className={ladderContentClass}>
                <L5XRoutineViewer
                  routine={routine}
                  fbdSheetIndex={fbdSheetIndices[routineKey] ?? 0}
                  onFbdSheetIndexChange={(sheetIndex) => {
                    setFbdSheetIndices((current) => ({ ...current, [routineKey]: sheetIndex }));
                  }}
                />
              </div>
            </div>
          );
        }
        return (
          <div key={tabId} className={containerClass}>
            <p className="text-center text-theme-secondary py-10">Routine not found</p>
          </div>
        );
      }

      case 'module': {
        const module = controller.modules.find(m => m.name === tabData.moduleName);
        if (module) {
          return (
            <div key={tabId} className={containerClass}>
              <div className="flex-1 overflow-auto p-4">
                <ModuleInfoTable module={module} />
              </div>
            </div>
          );
        }
        return (
          <div key={tabId} className={containerClass}>
            <p className="text-center text-theme-secondary py-10">Module not found</p>
          </div>
        );
      }

      default:
        return null;
    }
  }, [document, documentRecords, controller, ambiguousProgramUids, fbdSheetIndices, handleDataTypeSelect, normalizedFilePath, handleOpen, onShowRaw, openTab]);

  // ============================================================================
  // Main Content Rendering
  // ============================================================================

  const renderMainContent = () => {

    if (tabs.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-2 bg-theme-surface">
          <p className="text-theme-primary font-medium">No Content Selected</p>
          <p className="text-sm">Select an item from the navigation panel to view its contents</p>
        </div>
      );
    }

    // Render all tabs (keeping inactive ones mounted but hidden)
    return (
      <>
        {tabs.map(tab => renderTabContent(tab.data, tab.id === activeTabId, tab.id))}
      </>
    );
  };

  // ============================================================================
  // Render States
  // ============================================================================

  // Loading state
  if (isLoading) {
    const fileName = getPathFileName(filePath);
    return (
      <div className="flex items-center justify-center h-full text-theme-secondary">
        <div className="animate-pulse flex items-center gap-2">
          <Cpu size={ICON_SIZES.md} />
          <span>Parsing {fileName}...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-secondary gap-3">
        <AlertCircle size={ICON_SIZES.lg} className="text-theme-error" />
        <div className="text-center">
          <p className="text-theme-primary font-medium mb-1">Cannot load L5X file</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!document || documentResult?.status === 'failed') {
    return (
      <div className="flex h-full flex-col bg-theme-surface text-theme-secondary">
        {documentResult && <L5XDocumentStatus result={documentResult} onShowRaw={onShowRaw} />}
        {documentResult?.status !== 'failed' && (
          <p className="p-4 text-sm">No structured view is available for this export target. Use Raw to inspect the file.</p>
        )}
      </div>
    );
  }

  // ============================================================================
  // Main Render
  // ============================================================================

  return (
    <div className="h-full flex flex-col overflow-hidden bg-theme-surface">
      <L5XDocumentStatus result={documentResult} onShowRaw={onShowRaw} records={documentRecords} onOpen={handleOpen} />
      {/* Main content area */}
      <div className="min-h-0 min-w-0 flex-1 flex overflow-hidden">
        {/* Navigator sidebar */}
        {uiState.showNavigator && (
          <div className="w-64 bg-theme-surface overflow-hidden flex flex-col">
            <Button size="sm" variant="ghost" className="m-2 shrink-0 justify-start"
              onClick={() => openTab({ type: 'document', selection: { kind: 'source' } }, 'Document')}>Document</Button>
            {controller && <L5XProjectOrganizer
              controller={controller}
              programs={controller.programs}
              onOpen={handleOpen}
              activeTabData={activeTabData}
              ambiguousProgramUids={ambiguousProgramUids}
              className="flex-1"
            />}
          </div>
        )}

        {/* Toggle button for navigator */}
        <button
          onClick={toggleNavigator}
          className="flex items-center justify-center w-5 bg-theme-surface border-r border-shell-divider hover:bg-theme-muted transition-colors"
          title={uiState.showNavigator ? 'Hide navigator' : 'Show navigator'}
        >
          {uiState.showNavigator ? (
            <ChevronLeft size={ICON_SIZES.xs} className="text-theme-secondary" />
          ) : (
            <ChevronRight size={ICON_SIZES.xs} className="text-theme-secondary" />
          )}
        </button>

        {/* Content area with tabs */}
        <div className="min-h-0 min-w-0 flex-1 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabSelect={selectTab}
            onTabClose={closeTab}
          />
          
          {/* Tab content */}
          <div className="flex-1 overflow-hidden relative">
            {renderMainContent()}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(L5XViewer);
