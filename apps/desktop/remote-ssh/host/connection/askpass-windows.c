#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static DWORD parent_process_id(void) {
    DWORD parent = 0;
    DWORD current = GetCurrentProcessId();
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W process = {0};
    process.dwSize = sizeof(process);
    for (BOOL valid = Process32FirstW(snapshot, &process); valid;
         valid = Process32NextW(snapshot, &process)) {
        if (process.th32ProcessID == current) {
            parent = process.th32ParentProcessID;
            break;
        }
    }
    CloseHandle(snapshot);
    return parent;
}

static int askpass(unsigned short port, const char *request, int request_length) {
    SOCKET socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_handle == INVALID_SOCKET) return 1;

    DWORD timeout_ms = 5000;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    char response[1024];
    int length = 0;
    int result = 1;

    if (setsockopt(socket_handle, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms)) != 0 ||
        setsockopt(socket_handle, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms)) != 0 ||
        connect(socket_handle, (const struct sockaddr *)&address, sizeof(address)) != 0) goto done;
    while (request_length > 0) {
        int sent = send(socket_handle, request, request_length, 0);
        if (sent <= 0) goto done;
        request += sent;
        request_length -= sent;
    }
    for (;;) {
        int received = recv(socket_handle, response + length, (int)sizeof(response) - length, 0);
        if (received < 0) goto done;
        if (received == 0) break;
        length += received;
        if (length == sizeof(response)) goto done;
    }
    DWORD written;
    if (length > 0 && WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), response, (DWORD)length, &written, NULL) &&
        written == (DWORD)length) result = 0;

done:
    SecureZeroMemory(response, sizeof(response));
    closesocket(socket_handle);
    return result;
}

int wmain(int argc, wchar_t **argv) {
    // OpenSSH marks host confirmation and other non-password prompts with a hint.
    static const wchar_t suffix[] = L"'s password: ";
    wchar_t hint[2];
    if (argc != 2 || GetEnvironmentVariableW(L"SSH_ASKPASS_PROMPT", hint, 2)) return 1;
    size_t prompt_length = wcslen(argv[1]);
    size_t suffix_length = (sizeof(suffix) / sizeof(*suffix)) - 1;
    if (prompt_length <= suffix_length || wcscmp(argv[1] + prompt_length - suffix_length, suffix) != 0) return 1;

    char port_text[6];
    char nonce[65];
    DWORD port_length = GetEnvironmentVariableA("DSH_SSH_ASKPASS_PORT", port_text, sizeof(port_text));
    if (!port_length || port_length >= sizeof(port_text) || strspn(port_text, "0123456789") != port_length ||
        GetEnvironmentVariableA("DSH_SSH_ASKPASS_NONCE", nonce, sizeof(nonce)) != 64 ||
        strspn(nonce, "0123456789abcdef") != 64) return 1;
    unsigned long port = strtoul(port_text, NULL, 10);
    DWORD parent = parent_process_id();
    if (!port || port > 65535 || !parent) return 1;
    char request[80];
    int request_length = snprintf(request, sizeof(request), "%s:%lu\n", nonce, parent);
    if (request_length < 1 || request_length >= sizeof(request)) return 1;

    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 1;
    int result = askpass((unsigned short)port, request, request_length);
    WSACleanup();
    return result;
}
