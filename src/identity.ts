import type { User } from '../shared/types';
let current: User | null = null;
let generation = 0;
export const identityGeneration = () => generation;
export function setIdentity(user: User | null) {
  current = user;
  generation++;
}
export const getUserId = () => current?.id ?? null;
export const identityProvider = {
  getIdentity: () => current?.name ?? 'Member',
  isCurrentUser: (author: string | undefined) => author === current?.name,
  isEditable: () => false,
};
