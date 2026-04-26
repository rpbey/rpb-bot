import { type ArgsOf, Discord, On } from '@rpbey/discordx';

import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

@Discord()
export class MemberUpdateListener {
  @On({ event: 'guildMemberUpdate' })
  async onMemberUpdate([oldMember, newMember]: ArgsOf<'guildMemberUpdate'>) {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    if (
      oldRoles.size === newRoles.size &&
      oldRoles.every((role) => newRoles.has(role.id))
    ) {
      return;
    }

    const isAdmin = newMember.permissions.has('Administrator');
    const role = isAdmin ? 'admin' : 'user';

    try {
      await prisma.user.update({
        where: { discordId: newMember.id },
        data: { role },
      });

      logger.debug(`Synced role for ${newMember.user.tag}: ${role}`);
    } catch {
      // User might not be in DB yet, ignore
    }
  }
}
