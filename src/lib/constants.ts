export const Colors = {
  Primary: 0xdc2626, // RPB Red (from logo)
  Secondary: 0xfbbf24, // RPB Gold/Yellow (from logo)
  Success: 0x22c55e, // Green
  Warning: 0xf59e0b, // Orange
  Error: 0xef4444, // Red
  Info: 0x3b82f6, // Blue
  Beyblade: 0x8b5cf6, // Purple for Beyblade
  // Role Colors
  Admin: 0x27a169,
  Rh: 0x3498db,
  Modo: 0x9b59b6,
  Staff: 0x206694,
} as const;

export const Emojis = {
  Success: '✅',
  Error: '❌',
  Warning: '⚠️',
  Loading: '⏳',
  Info: 'ℹ️',
  Ping: '🏓',
  User: '👤',
  Server: '📋',
  Bot: '🤖',
  Kick: '👢',
  Ban: '🔨',
  Clear: '🧹',
  Welcome: '👋',
  // Beyblade specific
  Beyblade: '🌀',
  Tournament: '🏆',
  Battle: '⚔️',
  Win: '🥇',
  Lose: '💥',
} as const;

export const RPB = {
  Name: 'RPB Bot',
  FullName: 'République Populaire du Beyblade',
  Discord: 'https://discord.gg/9ENMe2hQyU',
  X: 'https://x.com/rpb_ey',
  Color: 0xdc2626,
  GoldColor: 0xfbbf24,
  // Channel names for auto-detection
  Channels: {
    Welcome: '1323816742262145105',
    Rules: '1323817313782337536',
    Roles: '1323817223911116872',
    Announcements: '1323816859337752626',
    Tournaments: '1448476446724063252',
    Social: '1333203623471087708',
    GeneralChat: '1319715782820892768',
    Suggestions: '1333200281416237132',
    Media: '1357709692603732119',
  },
  // Role IDs
  Roles: {
    Admin: '1319720685714804809',
    Rh: '1446871643753418793',
    Modo: '1448458421702754474',
    Staff: '1331256093434712095',
    Partenaires: '1457835411052298411',
    // Role Reaction Roles
    Participant: '1451549606608371814', // Rôle "Tournois"
    Spectateur: '1463903917346656378',
    Reseaux: '1456751013741592678',
    Events: '1456751317342224525',
    Leaks: '1456768275731058708',
    Restock: '1468310668716544061',
    Mudae: '1487686717711454340',
    Blader: '1323819786181804112',
    // Notification Roles
    TournoiNotification: '1451549606608371814',
  },
  // Role Icons (External URLs)
  RoleIcons: {
    Admin: 'https://rpbey.fr/logo-admin.webp',
    Modo: 'https://rpbey.fr/logo-modo.webp',
    Rh: 'https://rpbey.fr/logo-rh.webp',
    Staff: 'https://rpbey.fr/logo-staff.webp',
    Default: 'https://rpbey.fr/logo.webp',
  },
  // Partners
  Partners: {
    SATR: {
      Id: '1221611301332193371',
      Name: 'SATR',
      Invite: 'https://discord.gg/afEvCBF9XR',
      Website: 'https://sunafterthereign.carrd.co/',
      Challonge: 'https://challonge.com/fr/communities/sunafterthereign',
    },
    WB: {
      Id: '1295379706564055155',
      Name: 'WB',
      Invite: 'https://discord.gg/AcuSPdb2HQ',
      Challonge: 'https://challonge.com/fr/users/wild_breakers',
      Linktree: 'https://linktr.ee/wildbreakers#431784549',
    },
  },
  // Beyblade series
  Series: {
    BakutenShoot: 'Bakuten Shoot (2001-2003)',
    MetalFight: 'Metal Fight (2008-2012)',
    Burst: 'Burst (2016-2022)',
    X: 'X (2023+)',
  },
} as const;
