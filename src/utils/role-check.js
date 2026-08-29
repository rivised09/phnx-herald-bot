const { CONFIG } = require('../config');

function hasRole(member, roleId) {
  if (!member || !member.roles) return false;
  if (member.roles.cache) {
    return member.roles.cache.has(roleId);
  }
  return (member.roles || []).includes(roleId);
}

function hasLeadershipRole(member) {
  return hasRole(member, CONFIG.ROLES.LEADERSHIP);
}

function isLeadershipUser(interaction) {
  const member =
    interaction.member ||
    (interaction.guild ? interaction.guild.members.cache.get(interaction.user.id) : null);
  return hasLeadershipRole(member);
}

module.exports = { hasRole, hasLeadershipRole, isLeadershipUser };