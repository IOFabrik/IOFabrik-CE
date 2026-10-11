/**
 * GitConfigForm - Form for setting Git user name and email.
 */
import { memo, useCallback, useState, useEffect, type CSSProperties, type ChangeEvent, type JSX } from 'react';
import { User, Mail, CheckCircle, AlertCircle } from 'lucide-react';
import { ICON_SIZES } from '../../../shared/constants';
import { Button, Input, Label } from '../../../shared/ui';
import { GetUserProfile, SetUserProfile } from '../../../../bindings/iofabrik/services/settingsservice';

const iconStyle: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

interface FormMessage {
  type: 'success' | 'error';
  text: string;
}

interface OriginalValues {
  name: string;
  email: string;
}

function GitConfigForm(): JSX.Element {
  const [name, setName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [hasChanges, setHasChanges] = useState<boolean>(false);
  const [originalValues, setOriginalValues] = useState<OriginalValues>({ name: '', email: '' });

  useEffect(() => {
    const loadProfile = async (): Promise<void> => {
      try {
        const profile = await GetUserProfile('');
        setName(profile.name || '');
        setEmail(profile.email || '');
        setOriginalValues({ name: profile.name || '', email: profile.email || '' });
      } catch (err) {
        console.error('Failed to load user profile:', err);
      }
    };
    loadProfile();
  }, []);

  useEffect(() => {
    setHasChanges(name !== originalValues.name || email !== originalValues.email);
  }, [name, email, originalValues]);

  const handleSave = useCallback(async (): Promise<void> => {
    setIsSaving(true);
    setMessage(null);
    
    try {
      const result = await SetUserProfile('', { name, email }, true);
      if (result.success) {
        setMessage({ type: 'success', text: 'Git configuration saved' });
        setOriginalValues({ name, email });
        setHasChanges(false);
      } else {
        setMessage({ type: 'error', text: result.error || 'Failed to save' });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to save';
      setMessage({ type: 'error', text: errorMessage });
    }
    
    setIsSaving(false);
    setTimeout(() => setMessage(null), 4000);
  }, [name, email]);

  return (
    <div className="bg-theme-surface rounded-lg p-6 border border-theme-default">
      <h3 className="text-theme-primary font-medium mb-4">Git Identity</h3>
      <p className="text-theme-muted text-sm mb-6">This information will be used for your commits</p>
      
      <div className="space-y-4">
        <div>
          <Label>
            <User style={iconStyle} />
            <span>Name</span>
          </Label>
          <Input
            type="text"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            placeholder="Your name for commits"
          />
        </div>
        
        <div>
          <Label>
            <Mail style={iconStyle} />
            <span>Email</span>
          </Label>
          <Input
            type="email"
            value={email}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            placeholder="Your email for commits"
          />
        </div>
      </div>

      <div className="flex items-center justify-between mt-6 pt-4 border-t border-theme-default">
        {message ? (
          <div className={`flex items-center gap-1.5 text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
            {message.type === 'success' 
              ? <CheckCircle style={iconStyle} /> 
              : <AlertCircle style={iconStyle} />
            }
            <span>{message.text}</span>
          </div>
        ) : (
          <span className="text-theme-muted text-sm">Applied globally for all repositories</span>
        )}
        
        <Button
          onClick={handleSave}
          disabled={!hasChanges}
          loading={isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}

export default memo(GitConfigForm);
