import axios from "axios";

export const ingestApi = axios.create({
  baseURL: "http://localhost:3000", // API server
  timeout: 5000,
});

