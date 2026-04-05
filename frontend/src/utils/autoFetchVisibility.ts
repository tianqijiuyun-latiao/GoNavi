import { useEffect, useState } from 'react';

type AutoFetchVisibilitySource = Partial<Pick<Document, 'hidden' | 'visibilityState'>> | undefined;

export const isAutoFetchVisible = (source?: AutoFetchVisibilitySource): boolean => {
  if (!source) {
    return true;
  }

  if (source.hidden === true) {
    return false;
  }

  if (source.visibilityState && source.visibilityState !== 'visible') {
    return false;
  }

  return true;
};

const getDocumentAutoFetchVisibility = (): boolean => {
  if (typeof document === 'undefined') {
    return true;
  }

  return isAutoFetchVisible(document);
};

export const useAutoFetchVisibility = (): boolean => {
  const [isVisible, setIsVisible] = useState<boolean>(() => getDocumentAutoFetchVisibility());

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const syncVisibility = () => {
      setIsVisible(getDocumentAutoFetchVisibility());
    };

    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    window.addEventListener('focus', syncVisibility);
    window.addEventListener('pageshow', syncVisibility);

    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('focus', syncVisibility);
      window.removeEventListener('pageshow', syncVisibility);
    };
  }, []);

  return isVisible;
};
