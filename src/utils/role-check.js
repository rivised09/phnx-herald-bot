const { CONFIG } = require('../config');

function hasAnyRole(member, roleIds) {
  if (!member || !roleIds || roleIds.length === 0) return false;
  if (member.roles.cache) {
    return roleIds.some((id) => member.roles.cache.has(id));
  }
  const rolesList = member.roles || [];
  return roleIds.some((id) => rolesList.includes(id));
}

function hasLeadershipRole(member) {
  return hasAnyRole(member, CONFIG.ROLES.LEADERSHIP);
}

function isLeadershipUser(interaction) {
  const member =
    interaction.member ||
    (interaction.guild ? interaction.guild.members.cache.get(interaction.user.id) : null);
  return hasLeadershipRole(member);
}

module.exports = { hasAnyRole, hasLeadershipRole, isLeadershipUser, hasRole: hasAnyRole };