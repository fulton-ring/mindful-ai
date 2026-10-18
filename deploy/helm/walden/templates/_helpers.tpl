{{- define "walden.name" -}}
{{- printf "%s-walden" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "walden.image" -}}
{{ required "image.repository is required" .Values.image.repository }}:{{ required "image.tag is required; pin an immutable release tag" .Values.image.tag }}
{{- end -}}
{{- define "walden.labels" -}}
app.kubernetes.io/name: walden
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "walden.env" -}}
- name: HOST
  value: 0.0.0.0
- name: PORT
  value: '3000'
- name: DATA_DIR
  value: /data
{{- range $name, $value := .Values.config }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}
{{- define "walden.security" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  {{- toYaml .Values.seccompProfile | nindent 2 }}
{{- end -}}
