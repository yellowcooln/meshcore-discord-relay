export function isValidTopicFilter(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return false;
  }

  const patternParts = pattern.split('/');
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    if (patternPart.includes('#')) {
      return patternPart === '#' && i === patternParts.length - 1;
    }
    if (patternPart.includes('+') && patternPart !== '+') {
      return false;
    }
  }

  return true;
}

export function normalizeTopicWhitelist(patterns = [], warn = () => {}) {
  const normalized = [];
  const seen = new Set();

  for (const pattern of patterns) {
    const trimmed = String(pattern || '').trim();
    if (!trimmed) {
      continue;
    }
    if (!isValidTopicFilter(trimmed)) {
      warn(`[config] Ignoring invalid MQTT_TOPIC_WHITELIST filter: ${trimmed}`);
      continue;
    }
    if (!seen.has(trimmed)) {
      normalized.push(trimmed);
      seen.add(trimmed);
    }
  }

  return normalized;
}

export function topicMatchesPattern(topic, pattern) {
  if (!topic || !pattern) {
    return false;
  }
  if (!isValidTopicFilter(pattern)) {
    return false;
  }

  const topicParts = topic.split('/');
  const patternParts = pattern.split('/');

  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];

    if (patternPart === '#') {
      return true;
    }

    if (patternPart === '+') {
      if (i >= topicParts.length) {
        return false;
      }
      continue;
    }

    if (i >= topicParts.length || topicParts[i] !== patternPart) {
      return false;
    }
  }

  return topicParts.length === patternParts.length;
}

export function isTopicAllowed(topic, topicWhitelist = []) {
  if (topicWhitelist.length === 0) {
    return true;
  }
  return topicWhitelist.some((pattern) => topicMatchesPattern(topic, pattern));
}
