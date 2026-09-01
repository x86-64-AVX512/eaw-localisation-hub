import { AuthError } from './auth-model.mjs';

export function isManager(user) {
  return Boolean(user?.roles?.some((role) => role === 'admin' || role === 'senior translator'));
}

export function requireManager(user) {
  if (!isManager(user)) {
    throw new AuthError('Administrator or senior translator role is required', 403, 'management_required');
  }
}

export function assertCanManageUser(actor, target) {
  requireManager(actor);
  if (!target) throw new AuthError('User was not found', 404, 'not_found');
  if (!actor.roles.includes('admin')) {
    if (actor.id === target.id) {
      throw new AuthError('Senior translators cannot manage their own account', 403, 'self_management_forbidden');
    }
    if (target.roles.includes('admin')) {
      throw new AuthError('Senior translators cannot manage administrators', 403, 'administrator_protected');
    }
  }
}

export function assertCanAssignRoles(actor, target, roles) {
  assertCanManageUser(actor, target);
  if (!actor.roles.includes('admin') && roles.includes('admin')) {
    throw new AuthError('Only administrators can assign the administrator role', 403, 'administrator_role_forbidden');
  }
  if (actor.id === target.id && actor.roles.includes('admin') && !roles.includes('admin')) {
    throw new AuthError('An administrator cannot remove their own administrator role', 409, 'self_admin_role_required');
  }
}

export function assertCanCreateInvite(actor, roles) {
  requireManager(actor);
  if (!actor.roles.includes('admin') && roles.includes('admin')) {
    throw new AuthError('Only administrators can create administrator invitations', 403, 'administrator_role_forbidden');
  }
}

export function assertCanManageInvite(actor, invite) {
  requireManager(actor);
  if (!invite) throw new AuthError('Invitation was not found', 404, 'not_found');
  if (!actor.roles.includes('admin') && invite.roles.includes('admin')) {
    throw new AuthError('Senior translators cannot manage administrator invitations', 403, 'administrator_protected');
  }
}
