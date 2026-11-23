#include <stdio.h>

int main(void)
{
    int a[] = {60, 75, 88, 92, 95, 71, 83};
    int n = 7;
    int i;
    int max = a[0];
    int maxPos = 0;

    for (i = 1; i < n; i++) {
        if (a[i] > max) {
            max = a[i];
            maxPos = i;
        }
    }

    printf("最高分 = %d，在第 %d 位\n", max, maxPos);

    return 0;
}
