const API_BASE = "https://mobile-wealth-api.onrender.com";

function getToken() {
    return localStorage.getItem("token");
}

async function apiFetch(url, options = {}) {
    try {
        const token = getToken();

        const headers = {
            "Content-Type": "application/json",
            ...(options.headers || {})
        };

        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        const res = await fetch(`${API_BASE}${url}`, {
            ...options,
            headers
        });

        let data;
        try {
            data = await res.json();
        } catch (e) {
            data = null;
        }

        if (!res.ok) {
            throw new Error(data?.message || "Request failed");
        }

        return data;

    } catch (err) {
        console.log("API Error:", err.message);
        throw err;
    }
}