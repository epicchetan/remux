//! Wall-clock helpers shared across the runtime: epoch milliseconds and
//! JS-`Date#toISOString`-compatible UTC timestamps (millisecond precision).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn now_iso8601() -> String {
    iso8601_from_ms(now_ms())
}

/// Formats epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`, matching
/// JavaScript's `Date#toISOString` for dates in the supported range.
pub fn iso8601_from_ms(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);

    let (year, month, day) = civil_from_days(days);
    let hours = ms_of_day / 3_600_000;
    let minutes = (ms_of_day % 3_600_000) / 60_000;
    let seconds = (ms_of_day % 60_000) / 1_000;
    let millis = ms_of_day % 1_000;

    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

/// Days-since-epoch to civil date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_date_to_iso_string() {
        assert_eq!(iso8601_from_ms(0), "1970-01-01T00:00:00.000Z");
        // 2026-06-20T00:00:00.000Z
        assert_eq!(
            iso8601_from_ms(1_781_913_600_000),
            "2026-06-20T00:00:00.000Z"
        );
        assert_eq!(
            iso8601_from_ms(1_781_913_600_123),
            "2026-06-20T00:00:00.123Z"
        );
        // Leap-year day: 2024-02-29T12:00:00.000Z
        assert_eq!(
            iso8601_from_ms(1_709_208_000_000),
            "2024-02-29T12:00:00.000Z"
        );
    }
}
