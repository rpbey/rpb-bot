/**
 * Re-export du scraper Challonge canonique (packages/rpb-challonge).
 * Ne JAMAIS dupliquer la logique ici — toute évolution va dans @rpbey/challonge.
 */
export {
  ChallongeScraper,
  type ChallongeScraperOptions,
  type ScrapedLogEntry,
  type ScrapedMatch,
  type ScrapedParticipant,
  type ScrapedStanding,
  type ScrapedStation,
  type ScrapedTournament,
  type ScrapedTournamentMetadata,
  type SetScore,
  normalizeSets,
  setsToLegacyString,
  sumSetWinsForPlayer,
  sumSetWinsForPlayer1,
} from "@rpbey/challonge";
