// A campaign's active window. Both boundaries are stored as absolute instants (UTC); the
// admin UI is responsible for converting the merchant's local wall-clock times into these
// instants. Core never reasons about wall-clock or named time zones.
export type Schedule = {
  readonly startsAt: Date;
  readonly endsAt: Date;
};

// A campaign is active when `now` is within [startsAt, endsAt], inclusive of both boundaries.
// The comparison is on absolute UTC instants (epoch milliseconds), so it is time-zone-agnostic:
// exactly at startsAt and exactly at endsAt are both active; one millisecond outside is not.
export function isCampaignActive(schedule: Schedule, now: Date): boolean {
  const t = now.getTime();
  return t >= schedule.startsAt.getTime() && t <= schedule.endsAt.getTime();
}
