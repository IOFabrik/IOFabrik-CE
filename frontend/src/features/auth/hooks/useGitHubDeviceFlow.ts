import { useCallback, useEffect, useRef, useState } from 'react';
import { useRepo } from '../../../context';
import type { GitHubDeviceFlowResult } from '../../../domain/repo/context/RepoContext.types';

export interface GitHubDeviceFlowState {
  isOpen: boolean;
  userCode: string;
  verificationUrl: string;
}

const CLOSED_DEVICE_FLOW_STATE: GitHubDeviceFlowState = {
  isOpen: false,
  userCode: '',
  verificationUrl: '',
};

function toOpenDeviceFlowState(result: GitHubDeviceFlowResult): GitHubDeviceFlowState {
  return {
    isOpen: true,
    userCode: result.userCode || '',
    verificationUrl: result.verificationUrl || 'https://github.com/login/device',
  };
}

interface UseGitHubDeviceFlowOptions {
  onStartError?: (message: string) => void;
}

interface UseGitHubDeviceFlowResult {
  deviceFlow: GitHubDeviceFlowState;
  isStarting: boolean;
  startDeviceFlow: () => Promise<boolean>;
  closeDeviceFlow: () => void;
  handleDeviceFlowOpenChange: (open: boolean) => void;
}

export function useGitHubDeviceFlow(
  options: UseGitHubDeviceFlowOptions = {},
): UseGitHubDeviceFlowResult {
  const { startGitHubLogin, isStartingGitHubLogin } = useRepo();
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlowState>(CLOSED_DEVICE_FLOW_STATE);
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => () => {
    requestRef.current += 1;
    startingRef.current = false;
  }, []);

  const closeDeviceFlow = useCallback((): void => {
    requestRef.current += 1;
    startingRef.current = false;
    setIsStarting(false);
    setDeviceFlow(CLOSED_DEVICE_FLOW_STATE);
  }, []);

  const startDeviceFlow = useCallback(async (): Promise<boolean> => {
    // The ref closes the gap before React renders the disabled button.
    if (startingRef.current) {
      return false;
    }
    startingRef.current = true;
    setIsStarting(true);
    const request = ++requestRef.current;
    try {
      const result = await startGitHubLogin();
      if (request !== requestRef.current || result.cancelled) {
        return false;
      }
      if (result.success && result.userCode) {
        setDeviceFlow(toOpenDeviceFlowState(result));
        return true;
      }
      options.onStartError?.(result.error || 'GitHub sign-in could not start. Try connecting again.');
      return false;
    } catch {
      if (request === requestRef.current) {
        options.onStartError?.('GitHub sign-in could not start. Try connecting again.');
      }
      return false;
    } finally {
      if (request === requestRef.current) {
        startingRef.current = false;
        setIsStarting(false);
      }
    }
  }, [options, startGitHubLogin]);

  const handleDeviceFlowOpenChange = useCallback((open: boolean): void => {
    if (!open) {
      closeDeviceFlow();
    }
  }, [closeDeviceFlow]);

  return {
    deviceFlow,
    isStarting: isStarting || isStartingGitHubLogin === true,
    startDeviceFlow,
    closeDeviceFlow,
    handleDeviceFlowOpenChange,
  };
}
