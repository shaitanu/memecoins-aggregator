import axios from "axios";
import pLimit from "p-limit";

// Create axios instance
export const http = axios.create({
  timeout: 10_000, // 10 seconds
});

// Limit how many requests can run at the same time
export const limit = pLimit(5); // max 5 parallel requests

// Add retry logic for 429 + 5xx
http.interceptors.response.use(
  (res) => res,
  async (error) => {
    const config = error.config;

    if (!config) return Promise.reject(error);

    // Track retry count
    config.__retryCount = config.__retryCount || 0;

    // Stop after 4 retries
    if (config.__retryCount >= 4) {
      return Promise.reject(error);
    }

    const status = error.response?.status;

    // Retry only on rate-limit or server errors
    if (status === 429 || (status >= 500 && status < 600)) {
      config.__retryCount++;

      const delay = Math.pow(2, config.__retryCount) * 300; // exponential backoff

      await new Promise((resolve) => setTimeout(resolve, delay));

      return http(config);
    }

    return Promise.reject(error);
  }
);
