# OpenAI Rate Limit Handling

## Problem
Getting 429 errors: `Rate limit reached for gpt-4o-mini in organization... Please try again in 293ms`

## Solution
Added automatic retry with exponential backoff.

## Changes Made

### 1. New Retry Helper ([lib/retry-helper.js](lib/retry-helper.js))
- Detects 429 rate limit errors
- Retries up to 5 times with exponential backoff
- Extracts suggested wait time from error message
- Adds 300ms throttle between image processing

### 2. Updated Invoice Extractor ([lib/invoice-extractor.js](lib/invoice-extractor.js))
- Wraps all OpenAI API calls with `RetryHelper.retry()`
- Adds 300ms delay between processing paper images
- Both vision and text extraction use retry logic

### 3. Updated Config ([config.js](config.js))
- Added rate limit documentation
- Added `o1-mini` pricing (in case you want to switch models)
- Model can be changed at line 6

## How It Works

When a rate limit is hit:
1. Catches the 429 error
2. Extracts wait time from error message (e.g., "293ms")
3. Waits the suggested time + 100ms buffer
4. Retries the request
5. If it fails again, doubles the wait time (exponential backoff)
6. Max 5 retries before giving up

## To Change Model

Edit [config.js](config.js#L6):

```javascript
model: 'gpt-4o-mini',  // Change to 'gpt-4o' or 'o1-mini'
```

## Rate Limits Reference

- **Free tier**: 200k tokens/min, 500 requests/min
- **Tier 1**: 2M tokens/min, 500 requests/min
- Check your limits: https://platform.openai.com/account/rate-limits

## Testing

The retry logic was tested and successfully handles rate limits:
```
Attempt 1 → Rate limit hit, waiting 600ms
Attempt 2 → Rate limit hit, waiting 1200ms  
Attempt 3 → Success
```
