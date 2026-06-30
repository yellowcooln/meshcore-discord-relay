export function topicMatchesPattern(topic, pattern) {
  if (!topic || !pattern) {
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
