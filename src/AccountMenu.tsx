import { Menu } from '@base-ui/react/menu';
import {
  UserRound,
  Users,
  Bot,
  Building2,
  LogOut,
} from 'lucide-react';
import type { User, Workspace } from '../shared/types';
import { initials } from './api';

export function AccountMenu({
  user,
  workspace,
  isAdmin,
  onOpen,
  onLogout,
}: {
  user: User;
  workspace?: Workspace;
  isAdmin: boolean;
  onOpen: (page: 'account' | 'members' | 'agents' | 'organization') => void;
  onLogout: () => void;
}) {
  return (
    <div className="account-controls">
      <Menu.Root>
        <Menu.Trigger
          className="user-card user-menu-trigger"
          aria-label={`Account menu for ${user.name}`}
        >
          <span className="avatar">{initials(user.name)}</span>
          <span className="user-menu-identity">
            <strong>{user.name}</strong>
            <small>{workspace?.role ?? 'Member'}</small>
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="choice-positioner"
            side="top"
            align="start"
            sideOffset={8}
          >
            <Menu.Popup
              className="account-menu"
              aria-label="Account and settings"
            >
              <div className="account-menu-identity">
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </div>
              <Menu.Item
                className="account-menu-item"
                onClick={() => onOpen('account')}
              >
                <UserRound size={16} />
                Account & appearance
              </Menu.Item>
              {workspace && (
                <Menu.Group>
                  <Menu.GroupLabel className="account-menu-label">
                    {workspace.name}
                  </Menu.GroupLabel>
                  <Menu.Item
                    className="account-menu-item"
                    onClick={() => onOpen('members')}
                  >
                    <Users size={16} />
                    Members
                  </Menu.Item>
                  <Menu.Item
                    className="account-menu-item"
                    onClick={() => onOpen('agents')}
                  >
                    <Bot size={16} />
                    Agent access
                  </Menu.Item>
                </Menu.Group>
              )}
              {isAdmin && (
                <Menu.Group>
                  <Menu.GroupLabel className="account-menu-label">
                    Administration
                  </Menu.GroupLabel>
                  <Menu.Item
                    className="account-menu-item"
                    onClick={() => onOpen('organization')}
                  >
                    <Building2 size={16} />
                    Organization
                  </Menu.Item>
                </Menu.Group>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button
        className="icon-button account-signout"
        aria-label="Sign out"
        title="Sign out"
        onClick={onLogout}
      >
        <LogOut size={17} />
      </button>
    </div>
  );
}
